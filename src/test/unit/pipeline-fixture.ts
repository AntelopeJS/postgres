import { SchemaInstance } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";
import { DecodingContext } from "../../implementations/database/context";
import { CompileExpression } from "../../implementations/database/expression";
import type { TableShape } from "../../implementations/database/fields";
import { ApplyStages } from "../../implementations/database/pipeline";
import {
  type Relation,
  Render,
  TableRelation,
} from "../../implementations/database/relation";
import type { OriginResolver } from "../../implementations/database/selection";
import {
  BOOL,
  FLOAT,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import { WithOptions } from "./spec-fixture";

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

export interface Directory {
  people: Person;
  products: Product;
}

const SCHEMA_ID = "directory";
export const TABLE_ID = "people";
const OTHER_TABLE_ID = "products";
export const TABLE = '"directory"."people"';
export const OTHER_TABLE = '"directory"."products"';
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

const SHAPES: Record<string, TableShape> = {
  [TABLE_ID]: PEOPLE,
  [OTHER_TABLE_ID]: PRODUCTS,
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

function Table<Name extends keyof Directory & string>(tableId: Name) {
  const schema = new SchemaInstance<Directory>(
    QueryStage("schema", { id: SCHEMA_ID }),
  );
  const instance = new SchemaInstance<Directory>(
    QueryStage("instance", { id: undefined }),
    schema,
  );
  return instance.table(tableId);
}

export function Root() {
  return Table(TABLE_ID);
}

export function Other() {
  return Table(OTHER_TABLE_ID);
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

export interface ParamLedger {
  referenced: number[];
  bound: number[];
}

const PARAM_MARKER = /\$(\d+)/g;
const FIRST_PARAM = 1;

function Ascending(left: number, right: number): number {
  return left - right;
}

function Positions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + FIRST_PARAM);
}

/**
 * The `$n` positions a rendered statement references, beside the positions the bind will supply.
 *
 * Every compiled fragment appends to the one collector, so a branch that was compiled and then
 * discarded — or a relation rendered twice — makes these two lists differ. PostgreSQL reports it
 * as `bind message supplies N parameters, but prepared statement requires M`, naming nothing about
 * the query, so the specs compare them directly rather than pinning one count.
 */
export function ReadParamLedger(applied: Applied): ParamLedger {
  const sql = Render(applied.relation);
  const markers = [...sql.matchAll(PARAM_MARKER)].map((match) =>
    Number(match[1]),
  );
  return {
    referenced: [...new Set(markers)].sort(Ascending),
    bound: Positions(applied.context.params.all().length),
  };
}
