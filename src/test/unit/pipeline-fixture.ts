import assert from "node:assert";
import { SchemaInstance } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";
import {
  CROSS_INSTANCE,
  type InstanceId,
} from "@antelopejs/interface-database/schema";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import { CompileExpression } from "../../implementations/database/expression";
import type { TableShape } from "../../implementations/database/fields";
import { ApplyStages } from "../../implementations/database/pipeline";
import {
  type Relation,
  Render,
  TableRelation,
} from "../../implementations/database/relation";
import {
  BuildRoot,
  type OriginResolver,
} from "../../implementations/database/selection";
import {
  BOOL,
  FLOAT,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  CompileWrite,
  SplitWrite,
} from "../../implementations/database/writes";
import {
  type WriteStatement,
  WriteTargetOf,
} from "../../implementations/database/writes-shared";
import { type ParamLedger, ParamLedgerOf, WithOptions } from "./spec-fixture";

export type { ParamLedger } from "./spec-fixture";
export { Occurrences } from "./spec-fixture";

export interface Person {
  name: string;
  age: number;
  isActive: boolean;
  joined: Date;
  meta: Record<string, unknown>;
}

export interface Product {
  name: string;
  price: number;
}

export interface Note {
  summary: string;
}

export interface Directory {
  people: Person;
  products: Product;
  notes: Note;
  logs: Record<string, unknown>;
}

const SCHEMA_ID = "directory";
export const TABLE_ID = "people";
const OTHER_TABLE_ID = "products";
const NOTES_TABLE_ID = "notes";
const LOGS_TABLE_ID = "logs";
export const TABLE = '"directory"."people"';
export const OTHER_TABLE = '"directory"."products"';
export const NOTES_TABLE = '"directory"."notes"';
export const LOGS_TABLE = '"directory"."logs"';
export const ROOT_ALIAS = "t0";
export const FROM_TABLE = `FROM ${TABLE} AS "${ROOT_ALIAS}"`;

const ROOT_STAGE_COUNT = 3;

const PEOPLE: TableShape = {
  fields: {
    name: { column: "name", type: TEXT },
    age: { column: "age", type: FLOAT },
    isActive: { column: "isActive", type: BOOL },
    joined: { column: "joined", type: TIMESTAMP },
    meta: { column: "meta", type: OPAQUE },
  },
};

const PRODUCTS: TableShape = {
  fields: {
    name: { column: "name", type: TEXT },
    price: { column: "price", type: FLOAT },
  },
};

/**
 * A shape whose column is not the field name it was declared under.
 *
 * `PgIdentifier` truncates a name past 63 bytes, so the two differ for any long enough field
 * (invariant 8) — and every other shape here spells them the same, which is the reading that
 * cannot tell a write naming the field apart from one naming the column.
 */
const NOTES: TableShape = {
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
const LOGS: TableShape = { fields: {} };

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

const SHAPES: Record<string, TableShape> = {
  [TABLE_ID]: PEOPLE,
  [OTHER_TABLE_ID]: PRODUCTS,
  [NOTES_TABLE_ID]: NOTES,
  [LOGS_TABLE_ID]: LOGS,
};

const INDEXES: Record<string, string[]> = {
  byNameAge: ["name", "age"],
};

/** The stubbed {@link OriginResolver} a pipeline spec compiles against, registry and all. */
const StubOrigin: OriginResolver = (schemaId, tableId) => ({
  schemaId,
  tableId,
  shape: Object.hasOwn(SHAPES, tableId) ? SHAPES[tableId] : PEOPLE,
  index: (name) => (Object.hasOwn(INDEXES, name) ? INDEXES[name] : [name]),
});

export function NewTable(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, StubOrigin(SCHEMA_ID, TABLE_ID));
}

interface StubCompilers {
  context: DecodingContext;
  subqueries: () => number;
}

/**
 * A context whose subquery compiler counts its calls before refusing them.
 *
 * The count is what lets a spec assert that a stage read a nested query directly rather than
 * routing it to the correlated-subquery compiler. Asserting only that compilation does not throw
 * proves that through the refusal alone, and stops proving anything the day the stub is given a
 * body that answers instead.
 *
 * The alias counter is advanced once here because {@link NewTable} spells {@link ROOT_ALIAS}
 * directly rather than asking for it — the two would otherwise both claim `t0`.
 */
function NewContext(): StubCompilers {
  let calls = 0;
  const context = new DecodingContext(CompileExpression, () => {
    calls++;
    throw new Error("this spec compiles no subquery");
  });
  context.resolveOrigin = StubOrigin;
  context.nextAlias();
  return { context, subqueries: () => calls };
}

function Table<Name extends keyof Directory & string>(
  tableId: Name,
  instanceId: InstanceId | undefined,
) {
  const schema = new SchemaInstance<Directory>(
    QueryStage("schema", { id: SCHEMA_ID }),
  );
  const instance = new SchemaInstance<Directory>(
    QueryStage("instance", { id: instanceId }),
    schema,
  );
  return instance.table(tableId);
}

export function Root() {
  return Table(TABLE_ID, undefined);
}

export function Other() {
  return Table(OTHER_TABLE_ID, undefined);
}

/** The same table read across every instance, which is the absence of an instance predicate. */
export function CrossInstanceRoot() {
  return Table(TABLE_ID, CROSS_INSTANCE);
}

/** The table whose one declared field is stored under a column of another name (invariant 8). */
export function NotesRoot() {
  return Table(NOTES_TABLE_ID, undefined);
}

/** The table that declares no fields, whose whole document lives in the overflow column. */
export function LogsRoot() {
  return Table(LOGS_TABLE_ID, undefined);
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

export function ApplyRaw(stages: QueryStage[], relation = NewTable()): Applied {
  const { context, subqueries } = NewContext();
  const applied = WithOptions({}, () => ApplyStages(relation, stages, context));
  return { relation: applied, context, subqueries: subqueries() };
}

export function Apply(query: StagedObject, relation = NewTable()): Applied {
  return ApplyRaw(Stages(query), relation);
}

export function Sql(query: StagedObject, relation = NewTable()): string {
  return Render(Apply(query, relation).relation);
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
  const context = new DecodingContext(CompileExpression, () => {
    throw new Error("this spec compiles no subquery");
  });
  context.resolveOrigin = StubOrigin;
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
 * A document as a caller hands one to a write, which is not a shape the contract can spell.
 *
 * `DeepPartial<T>` has no spelling for `_id` or for an undeclared key, and those are exactly what
 * the key column and the overflow column exist for, so every write spec casts through this.
 */
export type WriteDocument = Record<string, unknown>;

export function WrittenSql(written: Written): string {
  return written.statement.sql;
}

/** The alias a write statement gives the table it targets, which is the compiler's own. */
export const WRITE_ALIAS = "w0";

/** The alias the identity target's wrap claims when the pipeline spent none before it. */
export const WRAP_ALIAS = "t1";

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
 * Asserts invariant 16's bind half over a list of compiled writes.
 *
 * The one assertion every write spec makes and none of them varies: a statement referencing a `$n`
 * the bind will not supply, or binding one it never names, is a driver-level
 * `bind message supplies N parameters, but prepared statement requires M` that names nothing about
 * the query.
 */
export function ExpectBalancedLedger(written: Written[]): void {
  for (const one of written) {
    const ledger = ReadStatementLedger(one);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  }
}

/** The bind ledger of a compiled write — see {@link ParamLedgerOf} for what it catches. */
export function ReadStatementLedger(written: Written): ParamLedger {
  return ParamLedgerOf(
    written.statement.sql,
    written.context.params.all().length,
  );
}
