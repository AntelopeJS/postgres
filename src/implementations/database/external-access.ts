import type { RelationSummary } from "@antelopejs/interface-database-catalog";

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

/** The privileges a role holds on one relation, which decide what it may do to it. */
export type RelationPrivileges = Pick<
  RelationRow,
  "readable" | "someColumns" | "insert" | "update" | "delete"
>;

/** What the connected role may do to one relation, as the catalog reports it. */
export type RelationAccess = Pick<RelationSummary, "unmappable" | "writes">;

export const RELATION_KINDS = "('r', 'p', 'v', 'm', 'f')";

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

const PRIVILEGE_COLUMNS = `has_table_privilege(c.oid, 'SELECT') AS readable,
    has_any_column_privilege(c.oid, 'SELECT') AS "someColumns",
    has_table_privilege(c.oid, 'INSERT') AS insert,
    has_table_privilege(c.oid, 'UPDATE') AS update,
    has_table_privilege(c.oid, 'DELETE') AS delete`;

/** The relations a role may see, partitions left out; `$1` restricts them to some schemas, `NULL` to none. */
const VISIBLE_RELATIONS = `WHERE c.relkind IN ${RELATION_KINDS} AND NOT c.relispartition
    AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
    AND n.nspname NOT LIKE 'pg\\_%'
    AND has_schema_privilege(n.oid, 'USAGE')
    AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))`;

/**
 * Every relation a role may see, with the privileges and estimates a listing reports. A
 * partitioned parent's estimate sums its leaves, which carry the statistics.
 */
export const RELATIONS_SQL = `
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
    ${PRIVILEGE_COLUMNS},
    coalesce(p.analyzed, c.reltuples >= 0) AS analyzed,
    coalesce(p.statistics, CASE WHEN c.reltuples >= 0 THEN c.reltuples END)::float8 AS statistics,
    coalesce(p.live, s.n_live_tup)::float8 AS "liveTuples",
    obj_description(c.oid, 'pg_class') AS comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
  LEFT JOIN leaves p ON p.oid = c.oid
  ${VISIBLE_RELATIONS}
  ORDER BY n.nspname, c.relname`;

/** The privileges alone over the same relations as {@link RELATIONS_SQL}, without its estimates. */
export const PRIVILEGES_SQL = `
  SELECT ${PRIVILEGE_COLUMNS}
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  ${VISIBLE_RELATIONS}`;

const PARTIAL_GRANTS = "SELECT is granted on some of its columns only";
const NOT_READABLE = "the connected role cannot SELECT from it";

function UnmappableReason(row: RelationPrivileges): string | undefined {
  if (row.readable) {
    return undefined;
  }
  return row.someColumns ? PARTIAL_GRANTS : NOT_READABLE;
}

/**
 * Whether the role may read the relation as a whole, and which row changes it may make. A grant
 * on some columns only leaves it unmappable.
 */
export function AccessOf(row: RelationPrivileges): RelationAccess {
  return {
    unmappable: UnmappableReason(row),
    writes: { insert: row.insert, update: row.update, delete: row.delete },
  };
}
