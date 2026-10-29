import { expect } from "chai";
import assert from "node:assert";
import { SchemaInstance } from "@antelopejs/interface-database";
import {
  type DeepPartial,
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";
import {
  CROSS_INSTANCE,
  type InstanceId,
} from "@antelopejs/interface-database/schema";

import type {
  SchemaModel,
  TableModel,
} from "../../implementations/database/fields";
import { CompileSubquery } from "../../implementations/database/subquery";
import { CompileExpression } from "../../implementations/database/expression";
import {
  CompileWrite,
  SplitWrite,
} from "../../implementations/database/writes";
import {
  ApplyStages,
  CompileRelation,
} from "../../implementations/database/pipeline";
import {
  BuildRoot,
  type OriginResolver,
} from "../../implementations/database/selection";
import {
  type Relation,
  TableRelation,
} from "../../implementations/database/relation";
import { Render } from "../../implementations/database/render";
import {
  type WriteStatement,
  WriteTargetOf,
} from "../../implementations/database/writes-shared";
import {
  type ParamLedger,
  ParamLedgerOf,
  RefusingCompilers,
  WithOptions,
} from "./spec-fixture";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  type Compilers,
  DecodingContext,
  type SubqueryCompiler,
} from "../../implementations/database/context";

export type { ParamLedger } from "./spec-fixture";
export { Occurrences } from "./spec-fixture";

/** What the specs keep in the opaque `meta` column. */
interface Meta {
  owner?: string;
  name?: string;
}

/** A row of the `logs` table, which declares no fields: everything it holds is overflow. */
interface LogEntry {
  x?: number;
}

export interface Person {
  name: string;
  age: number;
  isActive: boolean;
  joined: Date;
  meta: Meta;
}

export interface Product {
  name: string;
  price: number;
}

export interface Note {
  summary: string;
}

interface Profile {
  name: string;
  skills: string[];
}

export interface Directory {
  people: Person;
  products: Product;
  notes: Note;
  logs: LogEntry;
  profiles: Profile;
}

const SCHEMA_ID = "directory";
export const TABLE_ID = "people";
const OTHER_TABLE_ID = "products";
const NOTES_TABLE_ID = "notes";
const LOGS_TABLE_ID = "logs";
const PROFILES_TABLE_ID = "profiles";
export const TABLE = '"directory"."people"';
export const OTHER_TABLE = '"directory"."products"';
export const NOTES_TABLE = '"directory"."notes"';
export const LOGS_TABLE = '"directory"."logs"';
export const PROFILES_TABLE = '"directory"."profiles"';
export const ROOT_ALIAS = "t0";
export const FROM_TABLE = `FROM ${TABLE} AS "${ROOT_ALIAS}"`;

const ROOT_STAGE_COUNT = 3;

const PEOPLE: TableModel = {
  fields: {
    name: { column: "name", type: TEXT },
    age: { column: "age", type: FLOAT },
    isActive: { column: "isActive", type: BOOL },
    joined: { column: "joined", type: TIMESTAMP },
    meta: { column: "meta", type: OPAQUE },
  },
};

const PRODUCTS: TableModel = {
  fields: {
    name: { column: "name", type: TEXT },
    price: { column: "price", type: FLOAT },
  },
};

/**
 * A shape whose column is not the field name it was declared under.
 *
 * `PgIdentifier` truncates a name past 63 bytes, so the two differ for any long enough field
 * — and every other shape here spells them the same, which is the reading that
 * cannot tell a write naming the field apart from one naming the column.
 */
const NOTES: TableModel = {
  fields: {
    summary: { column: "summ", type: TEXT },
  },
};

/**
 * A table declaring no fields, so every key it stores is an overflow one.
 *
 * The shape that has one physical column to write rather than several, which is where a write
 * assembling a parenthesised target list has to spell a bare column name instead.
 */
const LOGS: TableModel = { fields: {} };

/**
 * A shape declaring a field whose type is an array, which no other shape here does.
 *
 * The reading a subquery types differently from every scalar one: a value-mode nested query keeps
 * the projection's own type, and an array is where that is visible without a document to hide it
 * in.
 */
const PROFILES: TableModel = {
  fields: {
    name: { column: "name", type: TEXT },
    skills: { column: "skills", type: ArrayOf(TEXT) },
  },
};

/**
 * The document `ColumnRowSource.toJson` builds over the people table, at the given alias.
 *
 * Transcribed rather than derived: a spec that asked `BuildDocument` for its own expected value
 * would assert only that the builder is deterministic. The alias is a parameter because a union
 * of the table with itself spells the same document twice, once per side.
 */
export function PeopleDocument(alias: string): string {
  return (
    `(jsonb_strip_nulls(jsonb_build_object('_id', "${alias}"."_id",` +
    ` '_instance', NULLIF("${alias}"."_instance", ''),` +
    ` 'name', "${alias}"."name", 'age', "${alias}"."age",` +
    ` 'isActive', "${alias}"."isActive", 'joined', "${alias}"."joined"))` +
    ` || (CASE WHEN "${alias}"."meta" IS NULL THEN '{}'::jsonb` +
    ` ELSE jsonb_build_object('meta', "${alias}"."meta") END)` +
    ` || COALESCE("${alias}"."_extra", '{}'::jsonb))`
  );
}

export const DOCUMENT = PeopleDocument(ROOT_ALIAS);

/**
 * The physical row-mode select list `Render` builds over the people table, at the given alias.
 *
 * Transcribed for {@link PeopleDocument}'s reason. The alias is a parameter because a relation the
 * pipeline wrapped spells the list once per nesting level, each against the level below it.
 */
export function PeopleColumns(alias: string): string {
  return (
    `"${alias}"."_id", "${alias}"."_instance", "${alias}"."name", "${alias}"."age",` +
    ` "${alias}"."isActive", "${alias}"."joined", "${alias}"."meta", "${alias}"."_extra"`
  );
}

export const ROW_COLUMNS = PeopleColumns(ROOT_ALIAS);

/**
 * The document `ColumnRowSource.toJson` builds over the products table, at the given alias.
 *
 * Transcribed for {@link PeopleDocument}'s reason. It lives beside its people sibling because the
 * products table is the second query in every spec that needs two — a join, a lookup, a union and
 * a subquery — and four transcriptions of one shape are four chances for three of them to stay
 * right while the fourth silently stops describing what the compiler emits.
 */
export function ProductDocument(alias: string): string {
  return (
    `(jsonb_strip_nulls(jsonb_build_object('_id', "${alias}"."_id",` +
    ` '_instance', NULLIF("${alias}"."_instance", ''),` +
    ` 'name', "${alias}"."name", 'price', "${alias}"."price"))` +
    ` || COALESCE("${alias}"."_extra", '{}'::jsonb))`
  );
}

/** The physical row-mode select list `Render` builds over the products table, at the given alias. */
export function ProductColumns(alias: string): string {
  return (
    `"${alias}"."_id", "${alias}"."_instance", "${alias}"."name",` +
    ` "${alias}"."price", "${alias}"."_extra"`
  );
}

const MODELS: SchemaModel = {
  [TABLE_ID]: PEOPLE,
  [OTHER_TABLE_ID]: PRODUCTS,
  [NOTES_TABLE_ID]: NOTES,
  [LOGS_TABLE_ID]: LOGS,
  [PROFILES_TABLE_ID]: PROFILES,
};

const INDEXES = {
  byNameAge: ["name", "age"],
  byNameSkills: ["name", "skills"],
} satisfies Record<string, string[]>;

function IsIndexKey(name: string): name is keyof typeof INDEXES {
  return Object.hasOwn(INDEXES, name);
}

/** The stubbed {@link OriginResolver} a pipeline spec compiles against, registry and all. */
const StubOrigin: OriginResolver = (schemaId, tableId) => ({
  schemaId,
  tableId,
  model: Object.hasOwn(MODELS, tableId) ? MODELS[tableId] : PEOPLE,
  index: (name) => (IsIndexKey(name) ? INDEXES[name] : [name]),
});

export function NewTable(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, StubOrigin(SCHEMA_ID, TABLE_ID));
}

/** The row-mode relation over the one table declaring a field whose type is an array. */
export function NewProfiles(): Relation {
  return TableRelation(
    PROFILES_TABLE,
    ROOT_ALIAS,
    StubOrigin(SCHEMA_ID, PROFILES_TABLE_ID),
  );
}

interface StubContext {
  context: DecodingContext;
  subqueries: () => number;
}

function PipelineCompilers(): Compilers {
  return {
    ...RefusingCompilers(),
    expression: CompileExpression,
    relation: CompileRelation,
  };
}

/**
 * A pipeline context that counts the nested queries routed to the given subquery compiler.
 *
 * The count is what lets a spec assert that a stage read a nested query directly rather than
 * routing it to the correlated-subquery compiler. Asserting only that compilation does not throw
 * proves that through the refusal alone, and stops proving anything the day the compiler is one
 * that answers instead — which is why the count wraps both of them rather than only the stub.
 *
 * The alias counter is advanced once here because {@link NewTable} spells {@link ROOT_ALIAS}
 * directly rather than asking for it — the two would otherwise both claim `t0`.
 */
function CountingContext(subquery: SubqueryCompiler): StubContext {
  let calls = 0;
  const context = new DecodingContext(
    {
      ...PipelineCompilers(),
      subquery: (stages, inner) => {
        calls++;
        return subquery(stages, inner);
      },
    },
    StubOrigin,
  );
  context.nextAlias();
  return { context, subqueries: () => calls };
}

/**
 * A context whose subquery compiler counts its calls before refusing them.
 *
 * It counts and then delegates rather than throwing for itself, so the refusal every other fixture
 * raises stays owned by {@link RefusingCompilers}.
 */
function NewContext(): StubContext {
  return CountingContext(RefusingCompilers().subquery);
}

/**
 * A context whose subquery compiler is the real one, for the specs that want an answer.
 *
 * Deliberately a second constructor rather than a replacement for {@link NewContext}: the refusing
 * stub is what lets `union`'s specs prove that a stage read its nested query directly, and a
 * context that compiles one instead would make `subqueries === 0` true of both readings.
 */
function NewSubqueryContext(): StubContext {
  return CountingContext(CompileSubquery);
}

function Instance<Tables>(instanceId: InstanceId | undefined) {
  const schema = new SchemaInstance<Tables>(
    QueryStage("schema", { id: SCHEMA_ID }),
  );
  return new SchemaInstance<Tables>(
    QueryStage("instance", { id: instanceId }),
    schema,
  );
}

function Table<Name extends keyof Directory>(
  tableId: Name,
  instanceId: InstanceId | undefined,
) {
  return Instance<Directory>(instanceId).table(tableId);
}

export function Root() {
  return Table(TABLE_ID, undefined);
}

/** {@link Root} as a caller whose row type spells `_id` and undeclared keys reads and writes it. */
export function CallerRoot() {
  return Instance<CallerDirectory>(undefined).table(TABLE_ID);
}

export function Other() {
  return Table(OTHER_TABLE_ID, undefined);
}

/** The same table read across every instance, which is the absence of an instance predicate. */
export function CrossInstanceRoot() {
  return Table(TABLE_ID, CROSS_INSTANCE);
}

/** The table whose one declared field is stored under a column of another name. */
export function NotesRoot() {
  return Table(NOTES_TABLE_ID, undefined);
}

/** The table that declares no fields, whose whole document lives in the overflow column. */
export function LogsRoot() {
  return Table(LOGS_TABLE_ID, undefined);
}

/** The table declaring a field whose type is an array. */
export function ProfilesRoot() {
  return Table(PROFILES_TABLE_ID, undefined);
}

/** The pipeline stages of a recorded query, with the `schema`/`instance`/`table` root removed. */
export function Stages(query: StagedObject): QueryStage[] {
  return query.build().slice(ROOT_STAGE_COUNT);
}

export interface Applied {
  relation: Relation;
  context: DecodingContext;
  subqueries: number;
}

function AppliedIn(
  stub: StubContext,
  stages: QueryStage[],
  relation: Relation,
): Applied {
  const context = stub.context;
  const applied = WithOptions({}, () => ApplyStages(relation, stages, context));
  return { relation: applied, context, subqueries: stub.subqueries() };
}

export function ApplyRaw(stages: QueryStage[], relation = NewTable()): Applied {
  return AppliedIn(NewContext(), stages, relation);
}

export function Apply(query: StagedObject, relation = NewTable()): Applied {
  return ApplyRaw(Stages(query), relation);
}

export function Sql(query: StagedObject, relation = NewTable()): string {
  return Render(Apply(query, relation).relation);
}

/** {@link Apply} through the context that compiles a nested query instead of refusing it. */
export function ApplySubqueries(
  query: StagedObject,
  relation = NewTable(),
): Applied {
  return AppliedIn(NewSubqueryContext(), Stages(query), relation);
}

export function SubquerySql(
  query: StagedObject,
  relation = NewTable(),
): string {
  return Render(ApplySubqueries(query, relation).relation);
}

/** The bind ledger of a rendered relation — see {@link ParamLedgerOf} for what it catches. */
export function ReadParamLedger(applied: Applied): ParamLedger {
  return ParamLedgerOf(
    Render(applied.relation),
    applied.context.params.all().length,
  );
}

export interface Written {
  statement: WriteStatement;
  context: DecodingContext;
}

/**
 * Compiles a recorded query whose last stage writes, exactly as `RunQuery` compiles one.
 *
 * The alias counter is left where it starts, unlike {@link ApplyRaw}'s: the root relation comes
 * from {@link BuildRoot} here rather than from {@link NewTable}, so it claims {@link ROOT_ALIAS}
 * for itself.
 */
export function Write(query: StagedObject): Written {
  const context = new DecodingContext(PipelineCompilers(), StubOrigin);
  const statement = WithOptions({}, () => {
    const root = BuildRoot(query.build(), context);
    const split = SplitWrite(root.rest);
    assert(split.write, "this fixture compiles a query that ends in a write");
    const relation = ApplyStages(root.relation, split.pipeline, context);
    return CompileWrite(WriteTargetOf(root, relation), split.write, context);
  });
  return { statement, context };
}

/**
 * A person as a caller declares one.
 *
 * The caller's row type is its own declaration, independent of the schema: it spells the key
 * column, the columns the adapter owns, keys the schema does not declare (which live in the
 * overflow column) and keys a recorded lambda also uses, which are what the specs probe.
 */
interface CallerPerson extends Person {
  _id: string | number | null;
  _instance: string;
  _extra: { [key: string]: string };
  nickname: string;
  stale: string;
  stage: string;
  args: (string[] | number)[];
}

/** The caller's view of the directory, as {@link CallerRoot} reads and writes it. */
interface CallerDirectory {
  people: CallerPerson;
}

/** A document as a caller hands one to a write through {@link CallerRoot}. */
export type WriteDocument = DeepPartial<CallerPerson>;

export function WrittenSql(written: Written): string {
  return written.statement.sql;
}

/** The alias a write statement gives the table it targets, which is the compiler's own. */
const WRITE_ALIAS = "w0";

/** The alias the identity target's wrap claims when the pipeline spent none before it. */
const WRAP_ALIAS = "t1";

/**
 * The `WHERE` predicate every write that targets by identity compiles to, over one rendering.
 *
 * Transcribed once rather than per spec file: `update`, `replace` and `delete` reach it through the
 * same `IdentityTarget`, so three copies would let a change to the predicate stay green in two of
 * them. The wrap's alias is a parameter because it is whatever the alias counter had left — a
 * relation the pipeline wrapped, or a `SET` list that compiled a derived table, has already spent
 * one.
 */
export function IdentityPredicate(
  rendered: string,
  alias = WRAP_ALIAS,
): string {
  const key = `"${alias}"."_instance", "${alias}"."_id"`;
  return (
    `("${WRITE_ALIAS}"."_instance", "${WRITE_ALIAS}"."_id") IN` +
    ` (SELECT ${key} FROM (${rendered}) AS "${alias}")`
  );
}

/**
 * The predicate a payload's own `_id` compiles to, given the parameter it bound.
 *
 * Transcribed here for {@link IdentityPredicate}'s reason: `update` and `replace` reach it through
 * the same statement builder, so a second copy would let a change stay green in one of them.
 */
export function AssertedIdentity(param: string): string {
  return `("${WRITE_ALIAS}"."_id" = (${param}::text))`;
}

/** One assignment of a `SET` list, split back into the two halves the conjunct reads apart. */
interface WrittenColumn {
  column: string;
  value: string;
}

const ASSIGNS = " = ";
const NO_DEPTH = 0;
const SEPARATOR_WIDTH = 2;

/**
 * A `SET` list split into its assignments, on the commas that are not inside a call.
 *
 * The one thing these fixtures derive rather than transcribe, and it is safe in the direction that
 * matters: the input is the spec's own expected `SET` list, so a split that goes wrong builds an
 * expectation the compiler does not match and fails loudly. It can hide no defect, because the
 * compiler assembles the two halves from a list and never parses anything.
 */
function SplitAssignments(assignments: string): WrittenColumn[] {
  const parts: string[] = [];
  let depth = NO_DEPTH;
  let start = NO_DEPTH;
  for (let index = 0; index < assignments.length; index++) {
    const character = assignments[index];
    depth += Number(character === "(") - Number(character === ")");
    if (character === "," && depth === NO_DEPTH) {
      parts.push(assignments.slice(start, index));
      start = index + SEPARATOR_WIDTH;
    }
  }
  parts.push(assignments.slice(start));
  return parts.map((part) => ({
    column: part.slice(NO_DEPTH, part.indexOf(ASSIGNS)),
    value: part.slice(part.indexOf(ASSIGNS) + ASSIGNS.length),
  }));
}

/**
 * The conjunct that keeps a row the write would not change out of the count it answers.
 *
 * Derived from the `SET` list beside it because every statement `update` and `replace` compile
 * carries one, and spelling it out per spec would say the same thing thirty times over in files
 * whose subject is the `SET` list. Two specs transcribe it by hand instead, which is what pins the
 * derivation itself.
 */
export function UnchangedRows(assignments: string): string {
  const written = SplitAssignments(assignments);
  const columns = written.map((one) => `"${WRITE_ALIAS}".${one.column}`);
  const values = written.map((one) => one.value);
  return `((${columns.join(", ")}) IS DISTINCT FROM (${values.join(", ")}))`;
}

/** The one row a `get` selects, as the identity target renders it. */
export const SELECTED_ROW =
  `SELECT ${ROW_COLUMNS} ${FROM_TABLE}` +
  ` WHERE ("${ROOT_ALIAS}"."_instance" = ($1::text))` +
  ` AND ("${ROOT_ALIAS}"."_id" = ($2::text))`;

/** Every row of the instance, which is what a write with no selection in front of it targets. */
export const EVERY_ROW =
  `SELECT ${ROW_COLUMNS} ${FROM_TABLE}` +
  ` WHERE ("${ROOT_ALIAS}"."_instance" = ($1::text))`;

/**
 * Asserts the bind ledger over a list of compiled writes.
 *
 * The one assertion every write spec makes and none of them varies: a statement referencing a `$n`
 * the bind will not supply, or binding one it never names, is a driver-level
 * `bind message supplies N parameters, but prepared statement requires M` that names nothing about
 * the query.
 */
export function expectBalancedLedger(written: Written[]): void {
  for (const one of written) {
    const ledger = ReadStatementLedger(one);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  }
}

/** The bind ledger of a compiled write — see {@link ParamLedgerOf} for what it catches. */
function ReadStatementLedger(written: Written): ParamLedger {
  return ParamLedgerOf(
    written.statement.sql,
    written.context.params.all().length,
  );
}
