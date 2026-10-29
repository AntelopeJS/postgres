import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { JsonKey, QuoteIdentifier, QuoteLiteral } from "./sql";
import {
  IsJsonBacked,
  OPAQUE,
  PhysicalType,
  type SqlType,
  TEXT,
} from "./types";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
  RESERVED_COLUMNS,
} from "./utils";
import {
  type FieldSpec,
  PhysicalOrder,
  type SchemaModel,
  type TableModel,
} from "./fields";
import {
  CrossInstanceIndexName,
  IndexName,
  QualifiedName,
  ReplacementIndexName,
  TableName,
} from "./identifier";

type IndexMethod = "btree" | "gin";

/**
 * The field a column stores, present on the declared columns and absent on the reserved three.
 *
 * Both halves are needed together or not at all: the *field* is the key the overflow document filed
 * the value under before the column existed, and the *type* is what reads it back out. Carrying them
 * as one member is what stops a caller supplying one without the other.
 */
export interface DeclaredField {
  readonly field: string;
  readonly type: SqlType;
}

export interface ColumnPlan {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly defaultExpression?: string;
  readonly declared?: DeclaredField;
}

/**
 * One physical index. `isUnique` is set on the instance-prefixed index of a `unique` declaration
 * only: its key leads with `_instance`, so the constraint holds within each instance, which is the
 * contract. The unprefixed `crossInstance` twin is never unique, since rows of different instances
 * may share a key.
 */
export interface IndexPlan {
  readonly id: string;
  readonly name: string;
  readonly method: IndexMethod;
  readonly keys: readonly string[];
  readonly isUnique: boolean;
  readonly signature: string;
}

export interface TablePlan {
  readonly id: string;
  readonly table: string;
  readonly columns: readonly ColumnPlan[];
  readonly indexes: readonly IndexPlan[];
}

const BTREE: IndexMethod = "btree";
const GIN: IndexMethod = "gin";
const SIGNATURE_VENDOR = "antelopejs";
const SIGNATURE_VERSION = "1";
const SIGNATURE_PREFIX = `${SIGNATURE_VENDOR}:${SIGNATURE_VERSION}`;
/**
 * Marks a unique index's signature, so adding or removing the flag reads as drift and the index is
 * rebuilt. A non-unique signature carries no marker and stays what earlier versions wrote.
 */
const UNIQUE_SIGNATURE_MARKER = "unique:";

/**
 * The columns a row's identity is the primary key of, in the order the constraint declares them.
 *
 * Exported because a write's `ON CONFLICT` has to name a unique constraint *identically* to reach
 * it — a different order or a different pair is `42P10 there is no unique or exclusion constraint
 * matching the ON CONFLICT specification`, at execution and only on the upsert path.
 */
export const PRIMARY_KEY_COLUMNS: readonly string[] = [
  INSTANCE_COLUMN,
  ID_COLUMN,
];

/** That same list as the constraint declares it, so the two spellings cannot drift apart. */
export const PRIMARY_KEY_LIST = PRIMARY_KEY_COLUMNS.map((column) =>
  QuoteIdentifier(column),
).join(", ");

const ID_PLAN: ColumnPlan = {
  name: ID_COLUMN,
  type: PhysicalType(TEXT),
  notNull: true,
};
const INSTANCE_PLAN: ColumnPlan = {
  name: INSTANCE_COLUMN,
  type: PhysicalType(TEXT),
  notNull: true,
  defaultExpression: "''",
};
const EXTRA_PLAN: ColumnPlan = {
  name: EXTRA_COLUMN,
  type: PhysicalType(OPAQUE),
  notNull: true,
  defaultExpression: "'{}'::jsonb",
};

export function ColumnDdl(column: ColumnPlan): string {
  const parts = [QuoteIdentifier(column.name), column.type];
  if (column.notNull) {
    parts.push("NOT NULL");
  }
  if (column.defaultExpression) {
    parts.push(`DEFAULT ${column.defaultExpression}`);
  }
  return parts.join(" ");
}

const RESERVED_INDEX_KEYS = new Map([[ID_COLUMN, QuoteIdentifier(ID_COLUMN)]]);

function IndexKey(indexId: string, field: string, spec?: FieldSpec): string {
  if (spec) {
    return QuoteIdentifier(spec.column);
  }
  const reserved = RESERVED_INDEX_KEYS.get(field);
  if (reserved !== undefined) {
    return reserved;
  }
  if (RESERVED_COLUMNS.includes(field)) {
    throw new Error(
      `Index '${indexId}' keys on '${field}', which is a reserved column the adapter owns; index a declared field instead`,
    );
  }
  return JsonKey(QuoteIdentifier(EXTRA_COLUMN), field);
}

/**
 * The fields an index keys on, in order — the name itself when the definition declares none, so
 * the DDL that creates the index and the reader that sorts by it expand it the same way.
 */
export function IndexFields(indexId: string, index: IndexDefinition): string[] {
  const declared = index.fields ?? [];
  return declared.length > 0 ? declared : [indexId];
}

type IndexSpecs = readonly (FieldSpec | undefined)[];

function IndexSpecs(fields: readonly string[], model: TableModel): IndexSpecs {
  return fields.map((field) =>
    Object.hasOwn(model.fields, field) ? model.fields[field] : undefined,
  );
}

/** A `multi` index over a single jsonb-backed field indexes its elements, through GIN. */
function IsElementWise(index: IndexDefinition, specs: IndexSpecs): boolean {
  const soleSpec = specs.length === 1 ? specs[0] : undefined;
  return (
    index.multi === true &&
    soleSpec !== undefined &&
    IsJsonBacked(soleSpec.type)
  );
}

function PhysicalIndex(
  id: string,
  name: string,
  method: IndexMethod,
  keys: readonly string[],
  isUnique = false,
): IndexPlan {
  const marker = isUnique ? UNIQUE_SIGNATURE_MARKER : "";
  return {
    id,
    name,
    method,
    keys,
    isUnique,
    signature: `${SIGNATURE_PREFIX}:${method}:${marker}${keys.join(",")}`,
  };
}

/**
 * A btree index leads with `_instance`; a `crossInstance` one also gets an unprefixed twin.
 * GIN is keyed on the column alone, so it already serves both kinds of read — and cannot be unique.
 */
function BuildIndexPlans(
  tableId: string,
  indexId: string,
  index: IndexDefinition,
  model: TableModel,
): IndexPlan[] {
  const fields = IndexFields(indexId, index);
  const specs = IndexSpecs(fields, model);
  const keys = fields.map((field, position) =>
    IndexKey(indexId, field, specs[position]),
  );
  const name = IndexName(tableId, indexId);
  const isUnique = index.unique === true;
  if (IsElementWise(index, specs)) {
    if (isUnique) {
      throw new Error(
        `Index '${indexId}' on table '${tableId}' is unique and multi over an array field, whose elements PostgreSQL cannot hold unique; drop one of the two flags`,
      );
    }
    return [PhysicalIndex(indexId, name, GIN, keys)];
  }
  const instanceKey = QuoteIdentifier(INSTANCE_COLUMN);
  const scopedKeys = [instanceKey, ...keys];
  const scoped = PhysicalIndex(indexId, name, BTREE, scopedKeys, isUnique);
  if (index.crossInstance !== true) {
    return [scoped];
  }
  const unscopedName = CrossInstanceIndexName(name);
  return [scoped, PhysicalIndex(indexId, unscopedName, BTREE, keys)];
}

/** Whether a physical index keyed without `_instance` backs this declared index. */
export function ServesCrossInstance(
  indexId: string,
  index: IndexDefinition,
  model: TableModel,
): boolean {
  if (index.crossInstance === true) {
    return true;
  }
  return IsElementWise(index, IndexSpecs(IndexFields(indexId, index), model));
}

export function BuildTablePlan(
  tableId: string,
  definition: TableDefinition,
  model: TableModel,
): TablePlan {
  const declared: ColumnPlan[] = Object.entries(model.fields).map(
    ([field, spec]) => ({
      name: spec.column,
      type: PhysicalType(spec.type),
      declared: { field, type: spec.type },
    }),
  );
  return {
    id: tableId,
    table: TableName(tableId),
    columns: PhysicalOrder(ID_PLAN, INSTANCE_PLAN, declared, EXTRA_PLAN),
    indexes: Object.entries(definition.indexes ?? {}).flatMap(
      ([indexId, index]) => BuildIndexPlans(tableId, indexId, index, model),
    ),
  };
}

interface GeneratedName {
  readonly name: string;
  readonly declaration: string;
}

function GeneratedNames(plans: readonly TablePlan[]): GeneratedName[] {
  return plans.flatMap((plan) => [
    { name: plan.table, declaration: `table '${plan.id}'` },
    ...plan.indexes.flatMap((index) => [
      {
        name: index.name,
        declaration: `index '${index.id}' on table '${plan.id}'`,
      },
      {
        name: ReplacementIndexName(index.name),
        declaration: `the rebuild of index '${index.id}' on table '${plan.id}'`,
      },
    ]),
  ]);
}

/**
 * Rejects a schema whose tables and indexes do not all get distinct names.
 *
 * Tables and indexes share one `pg_class` namespace per PostgreSQL schema, so a
 * generated index name can land on a name another declaration already owns.
 * Left to the server that surfaces as a `42P07` on the create path or a `42809`
 * on the drop path — which `IF EXISTS` does not suppress — by which point the
 * declarations responsible are no longer in reach of the message.
 */
export function AssertDistinctNames(plans: readonly TablePlan[]): void {
  const owners = new Map<string, string>();
  for (const generated of GeneratedNames(plans)) {
    const owner = owners.get(generated.name);
    if (owner !== undefined) {
      throw new Error(
        `The physical name '${generated.name}' is claimed by both ${owner} and ${generated.declaration}; rename one`,
      );
    }
    owners.set(generated.name, generated.declaration);
  }
}

/**
 * Turns a whole registered schema into the desired plans for its tables.
 *
 * Pure, and the only supported way to build them: the result is validated by
 * {@link AssertDistinctNames} before it is returned, so no caller can converge
 * a set of tables whose generated names collide.
 */
export function BuildSchemaPlan(
  schema: SchemaDefinition,
  model: SchemaModel,
): TablePlan[] {
  const plans = Object.entries(schema).map(([tableId, definition]) =>
    BuildTablePlan(tableId, definition, model[tableId]),
  );
  AssertDistinctNames(plans);
  return plans;
}

export function CreateSchemaSql(schemaName: string): string {
  return `CREATE SCHEMA IF NOT EXISTS ${QuoteIdentifier(schemaName)}`;
}

export function CreateTableSql(schemaName: string, plan: TablePlan): string {
  const body = [
    ...plan.columns.map(ColumnDdl),
    `PRIMARY KEY (${PRIMARY_KEY_LIST})`,
  ];
  const target = QualifiedName(schemaName, plan.table);
  return `CREATE TABLE IF NOT EXISTS ${target} (${body.join(", ")})`;
}

/** Builds an index without blocking writes, under its own name or under the one given. */
export function CreateIndexSql(
  schemaName: string,
  plan: TablePlan,
  index: IndexPlan,
  name: string = index.name,
): string[] {
  const target = QualifiedName(schemaName, plan.table);
  const reference = QualifiedName(schemaName, name);
  const kind = index.isUnique ? "UNIQUE INDEX" : "INDEX";
  return [
    `CREATE ${kind} CONCURRENTLY ${QuoteIdentifier(name)} ON ${target} USING ${index.method} (${index.keys.join(", ")})`,
    `COMMENT ON INDEX ${reference} IS ${QuoteLiteral(index.signature)}`,
  ];
}

/** True for an index carrying our signature comment, whatever its version. */
export function IsAdapterIndex(signature?: string): boolean {
  return signature?.startsWith(`${SIGNATURE_VENDOR}:`) === true;
}
