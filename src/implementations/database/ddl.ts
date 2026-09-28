import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { Cast } from "./coerce";
import type { MigrationMode } from "../../config";
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
import {
  type FieldSpec,
  PhysicalOrder,
  type SchemaShape,
  type TableShape,
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
interface DeclaredField {
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

/**
 * An index as `pg_catalog` reports it; `signature` is its comment, if any.
 * `valid` is `pg_index.indisvalid`: false for what a failed `CREATE INDEX CONCURRENTLY` left behind.
 */
export interface ActualIndex {
  readonly name: string;
  readonly signature?: string;
  readonly valid: boolean;
}

export interface ActualTable {
  readonly columns: readonly ActualColumn[];
  readonly indexes: readonly ActualIndex[];
}

/**
 * The DDL that converges a table, split by how it must run.
 *
 * `statements` run as one transaction: the table and its columns. `indexStatements` run one by one
 * after it, each in its own implicit transaction, because `CREATE INDEX CONCURRENTLY` and
 * `DROP INDEX CONCURRENTLY` refuse to run inside a transaction block.
 *
 * Index statements never drop an index before whatever replaces it is valid. A missing index is
 * built; one a failed concurrent build left invalid serves no read, so it is dropped and rebuilt; a
 * valid one whose signature drifted keeps serving while its replacement is built under
 * {@link ReplacementIndexName}, which is then swapped in — or simply renamed into place when a
 * crash left it ready. Adapter-signed indexes nothing declares any more are dropped last.
 *
 * The one index drop inside the transaction precedes a column retype: `ALTER COLUMN … TYPE`
 * rebuilds the indexes over that column with the default operator class of the *new* type, which
 * for a GIN index over a column becoming `text` does not exist. The retype rewrites the table under
 * an exclusive lock anyway, so dropping the obsolete indexes first costs no availability.
 */
export interface ConvergencePlan {
  statements: string[];
  indexStatements: string[];
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

type IndexSpecs = readonly (FieldSpec | undefined)[];

function IndexSpecs(fields: readonly string[], shape: TableShape): IndexSpecs {
  return fields.map((field) =>
    Object.hasOwn(shape.fields, field) ? shape.fields[field] : undefined,
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
): IndexPlan {
  return {
    id,
    name,
    method,
    keys,
    signature: `${SIGNATURE_PREFIX}:${method}:${keys.join(",")}`,
  };
}

/**
 * A btree index leads with `_instance`; a `crossInstance` one also gets an unprefixed twin.
 * GIN is keyed on the column alone, so it already serves both kinds of read.
 */
function BuildIndexPlans(
  tableId: string,
  indexId: string,
  index: IndexDefinition,
  shape: TableShape,
): IndexPlan[] {
  const fields = IndexFields(indexId, index);
  const specs = IndexSpecs(fields, shape);
  const keys = fields.map((field, position) =>
    IndexKey(indexId, field, specs[position]),
  );
  const name = IndexName(tableId, indexId);
  if (IsElementWise(index, specs)) {
    return [PhysicalIndex(indexId, name, GIN, keys)];
  }
  const instanceKey = QuoteIdentifier(INSTANCE_COLUMN);
  const scoped = PhysicalIndex(indexId, name, BTREE, [instanceKey, ...keys]);
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
  shape: TableShape,
): boolean {
  if (index.crossInstance === true) {
    return true;
  }
  return IsElementWise(index, IndexSpecs(IndexFields(indexId, index), shape));
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
    indexes: Object.entries(definition.indexes ?? {}).flatMap(
      ([indexId, index]) => BuildIndexPlans(tableId, indexId, index, shape),
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

/** Builds an index without blocking writes, under its own name or under the one given. */
export function CreateIndexSql(
  schemaName: string,
  plan: TablePlan,
  index: IndexPlan,
  name: string = index.name,
): string[] {
  const target = QualifiedName(schemaName, plan.table);
  const reference = QualifiedName(schemaName, name);
  return [
    `CREATE INDEX CONCURRENTLY ${QuoteIdentifier(name)} ON ${target} USING ${index.method} (${index.keys.join(", ")})`,
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

function DropIndexConcurrentlySql(schemaName: string, name: string): string {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${QualifiedName(schemaName, name)}`;
}

function RenameIndexSql(schemaName: string, from: string, to: string): string {
  return `ALTER INDEX ${QualifiedName(schemaName, from)} RENAME TO ${QuoteIdentifier(to)}`;
}

function IsRetyped(column: ColumnPlan, currentType: string): boolean {
  return Canonical(currentType) !== Canonical(column.type);
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
  if (!IsRetyped(column, current.type)) {
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

function RetypesAColumn(plan: TablePlan, actual: ActualTable): boolean {
  const found = new Map(actual.columns.map((column) => [column.name, column]));
  return plan.columns.some((column) => {
    const current = found.get(column.name);
    return current !== undefined && IsRetyped(column, current.type);
  });
}

function IsObsolete(
  index: ActualIndex,
  desired: ReadonlyMap<string, IndexPlan>,
): boolean {
  const wanted = desired.get(index.name);
  return wanted
    ? wanted.signature !== index.signature
    : IsAdapterIndex(index.signature);
}

/** Drops obsolete indexes ahead of a column retype, returning those left for the concurrent phase. */
function PlanRetypeDrops(
  schemaName: string,
  plan: TablePlan,
  actual: ActualTable,
  out: ConvergencePlan,
): readonly ActualIndex[] {
  if (!RetypesAColumn(plan, actual)) {
    return actual.indexes;
  }
  const desired = new Map(plan.indexes.map((index) => [index.name, index]));
  const obsolete = actual.indexes.filter((index) => IsObsolete(index, desired));
  for (const index of obsolete) {
    out.statements.push(DropIndexSql(schemaName, index.name));
  }
  return actual.indexes.filter((index) => !obsolete.includes(index));
}

/** The catalog entries at an index's own name and at the name its rebuild is staged under. */
interface IndexState {
  readonly current?: ActualIndex;
  readonly replacement?: ActualIndex;
}

function IsReady(index: IndexPlan, found: ActualIndex | undefined): boolean {
  return found?.valid === true && found.signature === index.signature;
}

function ClearSql(
  schemaName: string,
  found: ActualIndex | undefined,
): string[] {
  return found ? [DropIndexConcurrentlySql(schemaName, found.name)] : [];
}

/** Builds a drifted index's replacement beside it, and only then swaps it in. */
function ReplaceIndexSql(
  schemaName: string,
  plan: TablePlan,
  index: IndexPlan,
): string[] {
  const replacement = ReplacementIndexName(index.name);
  return [
    ...CreateIndexSql(schemaName, plan, index, replacement),
    DropIndexConcurrentlySql(schemaName, index.name),
    RenameIndexSql(schemaName, replacement, index.name),
  ];
}

/** Converges one physical index, in the order {@link ConvergencePlan} lays out. */
function PlanIndexBuild(
  schemaName: string,
  plan: TablePlan,
  index: IndexPlan,
  state: IndexState,
): string[] {
  const { current, replacement } = state;
  if (IsReady(index, current)) {
    return ClearSql(schemaName, replacement);
  }
  if (current === undefined && replacement && IsReady(index, replacement)) {
    return [RenameIndexSql(schemaName, replacement.name, index.name)];
  }
  const cleared = ClearSql(schemaName, replacement);
  if (current?.valid !== true) {
    const rebuilt = CreateIndexSql(schemaName, plan, index);
    return [...cleared, ...ClearSql(schemaName, current), ...rebuilt];
  }
  return [...cleared, ...ReplaceIndexSql(schemaName, plan, index)];
}

/** Builds every declared index, then drops the adapter's indexes nothing declares any more. */
function PlanIndexes(
  schemaName: string,
  plan: TablePlan,
  actual: readonly ActualIndex[],
): string[] {
  const found = new Map(actual.map((index) => [index.name, index]));
  const managed = new Set<string>();
  const statements: string[] = [];
  for (const index of plan.indexes) {
    const replacement = ReplacementIndexName(index.name);
    managed.add(index.name).add(replacement);
    const state = {
      current: found.get(index.name),
      replacement: found.get(replacement),
    };
    statements.push(...PlanIndexBuild(schemaName, plan, index, state));
  }
  for (const index of actual) {
    if (!managed.has(index.name) && IsAdapterIndex(index.signature)) {
      statements.push(DropIndexConcurrentlySql(schemaName, index.name));
    }
  }
  return statements;
}

/**
 * The concurrent index statements that converge a table whose columns already converged, in the
 * order {@link ConvergencePlan} lays out. Pure; a table the catalog does not hold has no index yet.
 */
export function PlanIndexStatements(
  schemaName: string,
  plan: TablePlan,
  actual: ActualTable,
): string[] {
  return PlanIndexes(schemaName, plan, actual.indexes);
}

/**
 * Diffs a desired table against the catalog, returning the DDL that converges
 * it. Pure: no I/O, and it throws rather than emitting a statement that would
 * lose data outside `destructive` mode.
 *
 * Tables and columns converge in the transaction; indexes converge after it,
 * concurrently — see {@link ConvergencePlan}.
 */
export function PlanTable(
  schemaName: string,
  plan: TablePlan,
  actual: ActualTable,
  mode: MigrationMode,
): ConvergencePlan {
  const out: ConvergencePlan = {
    statements: [],
    indexStatements: [],
    warnings: [],
  };
  if (actual.columns.length === 0) {
    out.statements.push(CreateTableSql(schemaName, plan));
    out.indexStatements.push(...PlanIndexes(schemaName, plan, []));
    return out;
  }
  const kept = PlanRetypeDrops(schemaName, plan, actual, out);
  PlanColumns(QualifiedName(schemaName, plan.table), plan, actual, mode, out);
  out.indexStatements.push(...PlanIndexes(schemaName, plan, kept));
  return out;
}
