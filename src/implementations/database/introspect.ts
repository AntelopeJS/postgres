import type { QueryResultRow } from "pg";
import { Query } from "../../connection";
import type { ActualColumn, ActualIndex, ActualTable } from "./ddl";

interface ColumnRow extends ActualColumn, QueryResultRow {}

interface IndexRow extends QueryResultRow {
  name: string;
  signature: string | null;
}

const COLUMNS_SQL = `
  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
    AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

const INDEXES_SQL = `
  SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS signature
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = $1 AND t.relname = $2 AND NOT i.indisprimary`;

function ReadIndex(row: IndexRow): ActualIndex {
  return { name: row.name, signature: row.signature ?? undefined };
}

/**
 * Reads a table's columns and secondary indexes out of `pg_catalog`.
 *
 * A table that does not exist reads back as an empty column list rather than an
 * error, which is how the planner spells "create it". The column query is
 * restricted to `relkind = 'r'`, so a name occupied by a view or a partitioned
 * table reads back as absent too — and the resulting `CREATE TABLE` fails
 * naming the conflict rather than silently adopting an object we do not own.
 */
export async function ReadTable(
  schemaName: string,
  tableName: string,
): Promise<ActualTable> {
  const target = [schemaName, tableName];
  const columns = await Query<ColumnRow>(COLUMNS_SQL, target);
  if (columns.rows.length === 0) {
    return { columns: [], indexes: [] };
  }
  const indexes = await Query<IndexRow>(INDEXES_SQL, target);
  return { columns: columns.rows, indexes: indexes.rows.map(ReadIndex) };
}
