import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";
import type { MigrationMode } from "../../config";
import { Cast } from "./coerce";
import {
  type FieldSpec,
  PhysicalOrder,
  type SchemaShape,
  type TableShape,
} from "./fields";
import { IndexName, QualifiedName, TableName } from "./identifier";
import { JSON_NULL, JsonKey, QuoteIdentifier, QuoteLiteral } from "./sql";
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

export type IndexMethod = "btree" | "gin";

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

export interface IndexPlan {
  readonly id: string;
  readonly name: string;
  readonly method: IndexMethod;
  readonly keys: readonly string[];
  readonly signature: string;
}

export interface TablePlan {
  readonly id: string;
  readonly table: string;
  readonly columns: readonly ColumnPlan[];
  readonly indexes: readonly IndexPlan[];
}

/** A column as `pg_catalog` reports it, with `format_type` spelling. */
export interface ActualColumn {
  readonly name: string;
  readonly type: string;
}

/** An index as `pg_catalog` reports it; `signature` is its comment, if any. */
export interface ActualIndex {
  readonly name: string;
  readonly signature?: string;
}

export interface ActualTable {
  readonly columns: readonly ActualColumn[];
  readonly indexes: readonly ActualIndex[];
}

export interface ConvergencePlan {
  statements: string[];
  warnings: string[];
}

const BTREE: IndexMethod = "btree";
const GIN: IndexMethod = "gin";
const SIGNATURE_VENDOR = "antelopejs";
const SIGNATURE_VERSION = "1";
const SIGNATURE_PREFIX = `${SIGNATURE_VENDOR}:${SIGNATURE_VERSION}`;

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

const RESERVED_INDEX_KEYS: Record<string, string> = {
  [ID_COLUMN]: QuoteIdentifier(ID_COLUMN),
};

function IndexKey(indexId: string, field: string, spec?: FieldSpec): string {
  if (spec) {
    return QuoteIdentifier(spec.column);
  }
  if (Object.hasOwn(RESERVED_INDEX_KEYS, field)) {
    return RESERVED_INDEX_KEYS[field];
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

function BuildIndexPlan(
  tableId: string,
  indexId: string,
  index: IndexDefinition,
  shape: TableShape,
): IndexPlan {
  const fields = IndexFields(indexId, index);
  const specs = fields.map((field) =>
    Object.hasOwn(shape.fields, field) ? shape.fields[field] : undefined,
  );
  const keys = fields.map((field, position) =>
    IndexKey(indexId, field, specs[position]),
  );
  const soleSpec = specs.length === 1 ? specs[0] : undefined;
  const elementWise =
    index.multi === true &&
    soleSpec !== undefined &&
    IsJsonBacked(soleSpec.type);
  const method = elementWise ? GIN : BTREE;
  const indexKeys = elementWise
    ? keys
    : [QuoteIdentifier(INSTANCE_COLUMN), ...keys];
  return {
    id: indexId,
    name: IndexName(tableId, indexId),
    method,
    keys: indexKeys,
    signature: `${SIGNATURE_PREFIX}:${method}:${indexKeys.join(",")}`,
  };
}

export function BuildTablePlan(
  tableId: string,
  definition: TableDefinition,
  shape: TableShape,
): TablePlan {
  const declared: ColumnPlan[] = Object.entries(shape.fields).map(
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
    indexes: Object.entries(definition.indexes ?? {}).map(([indexId, index]) =>
      BuildIndexPlan(tableId, indexId, index, shape),
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
    ...plan.indexes.map((index) => ({
      name: index.name,
      declaration: `index '${index.id}' on table '${plan.id}'`,
    })),
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
  shape: SchemaShape,
): TablePlan[] {
  const plans = Object.entries(schema).map(([tableId, definition]) =>
    BuildTablePlan(tableId, definition, shape[tableId]),
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

export function CreateIndexSql(
  schemaName: string,
  plan: TablePlan,
  index: IndexPlan,
): string[] {
  const target = QualifiedName(schemaName, plan.table);
  const reference = QualifiedName(schemaName, index.name);
  return [
    `CREATE INDEX ${QuoteIdentifier(index.name)} ON ${target} USING ${index.method} (${index.keys.join(", ")})`,
    `COMMENT ON INDEX ${reference} IS ${QuoteLiteral(index.signature)}`,
  ];
}

/** True for an index carrying our signature comment, whatever its version. */
export function IsAdapterIndex(signature?: string): boolean {
  return signature?.startsWith(`${SIGNATURE_VENDOR}:`) === true;
}

const DESTRUCTIVE: MigrationMode = "destructive";
const CAST_PIVOT_TYPE = PhysicalType(TEXT);

const CANONICAL_TYPES: Record<string, string> = {
  text: "text",
  "double precision": "double precision",
  boolean: "boolean",
  timestamptz: "timestamp with time zone",
  jsonb: "jsonb",
};

function Canonical(type: string): string {
  return Object.hasOwn(CANONICAL_TYPES, type) ? CANONICAL_TYPES[type] : type;
}

function AlterTable(target: string, action: string): string {
  return `ALTER TABLE ${target} ${action}`;
}

function DropIndexSql(schemaName: string, name: string): string {
  return `DROP INDEX IF EXISTS ${QualifiedName(schemaName, name)}`;
}

/**
 * Moves a newly declared field out of the overflow document and into its own column.
 * Lossless: a value the column cannot hold reads as NULL and stays in the overflow document.
 */
function BackfillSql(
  target: string,
  column: ColumnPlan,
  declared: DeclaredField,
): string {
  const overflow = QuoteIdentifier(EXTRA_COLUMN);
  const key = QuoteLiteral(declared.field);
  const stored = `NULLIF(${JsonKey(overflow, declared.field)}, ${JSON_NULL})`;
  const read = Cast({ sql: stored, type: OPAQUE }, declared.type).sql;
  const name = QuoteIdentifier(column.name);
  return (
    `UPDATE ${target} SET ${name} = ${read}, ${overflow} = ${overflow} - ${key}` +
    ` WHERE ${name} IS NULL AND ${read} IS NOT NULL`
  );
}

/**
 * Adds a column, and moves into it whatever the overflow document was holding for it.
 * The backfill is the one DML in the retried region: a replay follows a rollback, so it is safe.
 */
function PlanAddedColumn(
  target: string,
  column: ColumnPlan,
  out: ConvergencePlan,
): void {
  if (column.notNull && column.defaultExpression === undefined) {
    throw new Error(
      `Table ${target} has no '${column.name}' column and one cannot be added without a default, so the table was not created by this adapter; rename it or drop it`,
    );
  }
  out.statements.push(
    AlterTable(target, `ADD COLUMN IF NOT EXISTS ${ColumnDdl(column)}`),
  );
  if (column.declared) {
    out.statements.push(BackfillSql(target, column, column.declared));
  }
}

function PlanAlteredColumn(
  target: string,
  column: ColumnPlan,
  current: ActualColumn,
  mode: MigrationMode,
  out: ConvergencePlan,
): void {
  if (Canonical(current.type) === Canonical(column.type)) {
    return;
  }
  if (mode !== DESTRUCTIVE) {
    throw new Error(
      `Column '${column.name}' on ${target} is ${current.type} but the schema declares ${column.type}; set migrations: "destructive" to alter it`,
    );
  }
  const name = QuoteIdentifier(column.name);
  out.statements.push(
    AlterTable(
      target,
      `ALTER COLUMN ${name} TYPE ${column.type} USING (${name}::${CAST_PIVOT_TYPE}::${column.type})`,
    ),
  );
}

function PlanRemovedColumns(
  target: string,
  plan: TablePlan,
  actual: ActualTable,
  mode: MigrationMode,
  out: ConvergencePlan,
): void {
  const declared = new Set(plan.columns.map((column) => column.name));
  for (const column of actual.columns) {
    if (declared.has(column.name)) {
      continue;
    }
    if (mode === DESTRUCTIVE) {
      out.statements.push(
        AlterTable(target, `DROP COLUMN ${QuoteIdentifier(column.name)}`),
      );
      continue;
    }
    out.warnings.push(
      `Column '${column.name}' on ${target} is no longer declared and was left in place; set migrations: "destructive" to drop it`,
    );
  }
}

function PlanColumns(
  target: string,
  plan: TablePlan,
  actual: ActualTable,
  mode: MigrationMode,
  out: ConvergencePlan,
): void {
  const found = new Map(actual.columns.map((column) => [column.name, column]));
  for (const column of plan.columns) {
    const current = found.get(column.name);
    if (!current) {
      PlanAddedColumn(target, column, out);
      continue;
    }
    PlanAlteredColumn(target, column, current, mode, out);
  }
  PlanRemovedColumns(target, plan, actual, mode, out);
}

function PlanIndexDrops(
  schemaName: string,
  plan: TablePlan,
  actual: ActualTable,
  out: ConvergencePlan,
): void {
  const desired = new Map(plan.indexes.map((index) => [index.name, index]));
  for (const index of actual.indexes) {
    const wanted = desired.get(index.name);
    const obsolete = wanted
      ? wanted.signature !== index.signature
      : IsAdapterIndex(index.signature);
    if (obsolete) {
      out.statements.push(DropIndexSql(schemaName, index.name));
    }
  }
}

function PlanIndexCreates(
  schemaName: string,
  plan: TablePlan,
  actual: ActualTable,
  out: ConvergencePlan,
): void {
  const found = new Map(actual.indexes.map((index) => [index.name, index]));
  for (const index of plan.indexes) {
    if (found.get(index.name)?.signature === index.signature) {
      continue;
    }
    out.statements.push(...CreateIndexSql(schemaName, plan, index));
  }
}

function PlanCreation(
  schemaName: string,
  plan: TablePlan,
  out: ConvergencePlan,
): void {
  out.statements.push(CreateTableSql(schemaName, plan));
  for (const index of plan.indexes) {
    out.statements.push(...CreateIndexSql(schemaName, plan, index));
  }
}

/**
 * Diffs a desired table against the catalog, returning the DDL that converges
 * it. Pure: no I/O, and it throws rather than emitting a statement that would
 * lose data outside `destructive` mode.
 *
 * Statements come back in three phases — every index drop, then every column
 * change, then every index create. `ALTER COLUMN … TYPE` rebuilds the indexes
 * over that column before returning, and the rebuild picks the default operator
 * class of the *new* type, which for a GIN index over a column becoming `text`
 * does not exist; dropping first makes the rebuild moot.
 */
export function PlanTable(
  schemaName: string,
  plan: TablePlan,
  actual: ActualTable,
  mode: MigrationMode,
): ConvergencePlan {
  const out: ConvergencePlan = { statements: [], warnings: [] };
  if (actual.columns.length === 0) {
    PlanCreation(schemaName, plan, out);
    return out;
  }
  PlanIndexDrops(schemaName, plan, actual, out);
  PlanColumns(QualifiedName(schemaName, plan.table), plan, actual, mode, out);
  PlanIndexCreates(schemaName, plan, actual, out);
  return out;
}
