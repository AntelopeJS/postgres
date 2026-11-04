import assert from "node:assert";

import type {
  CatalogInfo,
  ColumnDescription,
  EstimateSource,
  IndexDescription,
  Reference,
  RelationDescription,
  RelationKey,
  RelationKind,
  RelationSummary,
} from "@antelopejs/interface-database-catalog";

import { Query } from "../../connection";
import {
  type CatalogColumn,
  type CatalogIndex,
  KeyOf,
  RELATION_KINDS,
  ReadColumns,
  ReadIndexes,
} from "./external-catalog";
import {
  AcceptedDeclarations,
  UnsupportedReason,
} from "./external-declarations";
import {
  Describe,
  DescribeKeyColumns,
  IsReadOnly,
  ReadOnlyReason,
} from "./external-types";
import { QualifiedName } from "./identifier";

/** One relation as the listing query reads it, before it is judged. */
export interface RelationRow {
  oid: number;
  schema: string;
  name: string;
  kind: string;
  readable: boolean;
  someColumns: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  analyzed: boolean;
  statistics: number | null;
  liveTuples: number | null;
  comment: string | null;
}

interface ReferenceRow {
  name: string;
  fromRelation: string;
  fromColumns: string[];
  toRelation: string;
  toColumns: string[];
}

interface InfoRow {
  version: string;
  database: string;
  role: string;
}

interface PlanRow {
  "QUERY PLAN": PlanNode[];
}

interface PlanEstimate {
  "Plan Rows": number;
}

interface PlanNode {
  Plan: PlanEstimate;
}

const ENGINE = "postgresql";

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

/**
 * Every relation a role may see, partitions left out, with the privileges and estimates a listing
 * reports. A partitioned parent's estimate sums its leaves, which carry the statistics.
 */
const RELATIONS_SQL = `
  WITH leaves AS (
    SELECT c.oid, coalesce(sum(CASE WHEN l.reltuples >= 0 THEN l.reltuples END), 0) AS statistics,
      coalesce(sum(s.n_live_tup), 0) AS live, bool_and(l.reltuples >= 0) AS analyzed
    FROM pg_class c
    JOIN LATERAL pg_partition_tree(c.oid) t ON t.isleaf
    JOIN pg_class l ON l.oid = t.relid
    LEFT JOIN pg_stat_all_tables s ON s.relid = l.oid
    WHERE c.relkind = 'p'
    GROUP BY c.oid
  )
  SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
    has_table_privilege(c.oid, 'SELECT') AS readable,
    has_any_column_privilege(c.oid, 'SELECT') AS "someColumns",
    has_table_privilege(c.oid, 'INSERT') AS insert,
    has_table_privilege(c.oid, 'UPDATE') AS update,
    has_table_privilege(c.oid, 'DELETE') AS delete,
    coalesce(p.analyzed, c.reltuples >= 0) AS analyzed,
    coalesce(p.statistics, CASE WHEN c.reltuples >= 0 THEN c.reltuples END)::float8 AS statistics,
    coalesce(p.live, s.n_live_tup)::float8 AS "liveTuples",
    obj_description(c.oid, 'pg_class') AS comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
  LEFT JOIN leaves p ON p.oid = c.oid
  WHERE c.relkind IN ${RELATION_KINDS} AND NOT c.relispartition
    AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    AND n.nspname NOT LIKE 'pg\\_%'
    AND has_schema_privilege(n.oid, 'USAGE')
    AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
  ORDER BY n.nspname, c.relname`;

const NAMED_RELATIONS_SQL = RELATIONS_SQL.replace(
  "AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))",
  "AND (n.nspname || '.' || c.relname) = ANY($1::text[])",
);

const COLUMN_LIST = (relation: string, keys: string) => `ARRAY(
      SELECT a.attname::text FROM unnest(con.${keys}) WITH ORDINALITY k(n, o)
      JOIN pg_attribute a ON a.attrelid = con.${relation} AND a.attnum = k.n
      ORDER BY k.o
    )`;

/** Declared foreign keys out of or into a relation, inherited partition copies left out. */
const REFERENCES_SQL = `
  SELECT con.conname AS name,
    fn.nspname || '.' || fc.relname AS "fromRelation", ${COLUMN_LIST("conrelid", "conkey")} AS "fromColumns",
    tn.nspname || '.' || tc.relname AS "toRelation", ${COLUMN_LIST("confrelid", "confkey")} AS "toColumns"
  FROM pg_constraint con
  JOIN pg_class fc ON fc.oid = con.conrelid
  JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  JOIN pg_class tc ON tc.oid = con.confrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE con.contype = 'f' AND con.conparentid = 0 AND (con.conrelid = $1 OR con.confrelid = $1)
  ORDER BY con.conname`;

const INFO_SQL = `
  SELECT current_setting('server_version') AS version, current_database() AS database,
    current_user AS role`;

const KINDS = new Map<string, RelationKind>([
  ["r", "table"],
  ["p", "partitioned"],
  ["v", "view"],
  ["m", "materialized"],
  ["f", "foreign"],
]);

function KindOf(row: RelationRow): RelationKind {
  const kind = KINDS.get(row.kind);
  assert(
    kind,
    `Relation ${RelationName(row)} has the unlisted kind '${row.kind}'`,
  );
  return kind;
}

const PARTIAL_GRANTS = "SELECT is granted on some of its columns only";
const NOT_READABLE = "the connected role cannot SELECT from it";

export function RelationName(row: RelationRow): string {
  return `${row.schema}.${row.name}`;
}

export async function ReadInfo(): Promise<CatalogInfo> {
  const [row] = (await Query<InfoRow>(INFO_SQL)).rows;
  return { engine: ENGINE, ...row };
}

export async function ReadRelationRows(
  schemas?: string[],
): Promise<RelationRow[]> {
  return (await Query<RelationRow>(RELATIONS_SQL, [schemas ?? null])).rows;
}

export async function ReadNamedRelationRows(
  relations: string[],
): Promise<RelationRow[]> {
  return (await Query<RelationRow>(NAMED_RELATIONS_SQL, [relations])).rows;
}

/** The planner's row estimate, for a relation the server keeps no statistics on. */
async function PlannedRows(row: RelationRow): Promise<number | null> {
  try {
    const sql = `EXPLAIN (FORMAT JSON) SELECT * FROM ${QualifiedName(row.schema, row.name)}`;
    const [plan] = (await Query<PlanRow>(sql)).rows;
    return plan["QUERY PLAN"][0].Plan["Plan Rows"];
  } catch {
    return null;
  }
}

interface Estimate {
  estimatedRows: number | null;
  estimate: EstimateSource | null;
}

/**
 * Statistics where the relation was analyzed, else the live-tuple counter the server keeps without
 * `ANALYZE`, else the planner's estimate — which is all a view has.
 */
export async function EstimateOf(row: RelationRow): Promise<Estimate> {
  if (row.analyzed && row.statistics !== null) {
    return { estimatedRows: row.statistics, estimate: "statistics" };
  }
  if (row.liveTuples !== null) {
    return { estimatedRows: row.liveTuples, estimate: "live-tuples" };
  }
  if (!row.readable) {
    return { estimatedRows: null, estimate: null };
  }
  const planned = await PlannedRows(row);
  return planned === null
    ? { estimatedRows: null, estimate: null }
    : { estimatedRows: planned, estimate: "plan" };
}

function UnmappableReason(row: RelationRow): string | undefined {
  if (row.readable) {
    return undefined;
  }
  return row.someColumns ? PARTIAL_GRANTS : NOT_READABLE;
}

/** The key registration aliases `_id` to: the same choice, over the same columns. */
export function KeyFrom(
  indexes: CatalogIndex[],
  columns: CatalogColumn[],
): RelationKey | null {
  const key = KeyOf(indexes);
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (!key || !DescribeKeyColumns(key.columns, byName)) {
    return null;
  }
  return { columns: key.columns, source: key.primary ? "primary" : "unique" };
}

async function SummaryOf(
  row: RelationRow,
  key: RelationKey | null,
): Promise<RelationSummary> {
  return {
    schema: row.schema,
    name: row.name,
    kind: KindOf(row),
    ...(await EstimateOf(row)),
    key,
    unmappable: UnmappableReason(row),
    writes: { insert: row.insert, update: row.update, delete: row.delete },
    comment: row.comment,
  };
}

export async function Summarize(row: RelationRow): Promise<RelationSummary> {
  const [columns, indexes] = await Promise.all([
    ReadColumns(row.oid),
    ReadIndexes(row.oid),
  ]);
  return SummaryOf(row, KeyFrom(indexes, columns));
}

function ReadOnlyOf(column: CatalogColumn, path: string): string | undefined {
  const [proposed] = AcceptedDeclarations(column);
  if (!proposed) {
    return undefined;
  }
  const descriptor = Describe(column.name, proposed.kind, column, path);
  return IsReadOnly(descriptor) ? ReadOnlyReason(descriptor) : undefined;
}

const IDENTITIES = new Map<string, ColumnDescription["identity"]>([
  ["a", "always"],
  ["d", "by default"],
]);

function DescribeColumn(
  column: CatalogColumn,
  relation: string,
): ColumnDescription {
  const accepts = AcceptedDeclarations(column).map(({ declared, lossy }) =>
    lossy ? { declared, lossy } : { declared },
  );
  const described: ColumnDescription = {
    name: column.name,
    native: column.native,
    nullable: !column.notNull,
    hasDefault: column.hasDefault,
    generated: column.generated,
    identity: IDENTITIES.get(column.identity) ?? null,
    accepts,
    comment: column.comment,
  };
  if (column.enumLabels) {
    described.enumLabels = column.enumLabels;
  }
  if (accepts.length === 0) {
    described.unsupported = UnsupportedReason(column);
  }
  const readOnly = ReadOnlyOf(column, `${relation}.${column.name}`);
  if (readOnly) {
    described.readOnly = readOnly;
  }
  return described;
}

function IndexOf(index: CatalogIndex): IndexDescription {
  return { name: index.name, columns: index.columns, unique: index.unique };
}

export function ReferenceOf(row: ReferenceRow): Reference {
  return {
    name: row.name,
    from: { relation: row.fromRelation, columns: row.fromColumns },
    to: { relation: row.toRelation, columns: row.toColumns },
  };
}

export async function ReadReferences(oid: number): Promise<ReferenceRow[]> {
  return (await Query<ReferenceRow>(REFERENCES_SQL, [oid])).rows;
}

export async function DescribeRow(
  row: RelationRow,
): Promise<RelationDescription> {
  const relation = RelationName(row);
  const [columns, indexes, references] = await Promise.all([
    ReadColumns(row.oid),
    ReadIndexes(row.oid),
    ReadReferences(row.oid),
  ]);
  return {
    ...(await SummaryOf(row, KeyFrom(indexes, columns))),
    columns: columns.map((column) => DescribeColumn(column, relation)),
    indexes: indexes.filter((index) => index.columns.length > 0).map(IndexOf),
    references: references
      .filter((reference) => reference.fromRelation === relation)
      .map(ReferenceOf),
    referencedBy: references
      .filter((reference) => reference.toRelation === relation)
      .map(ReferenceOf),
  };
}
