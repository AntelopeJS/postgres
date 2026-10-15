import { Query } from "../../connection";

/** One column of a relation the adapter did not create, as `pg_catalog` describes it. */
export interface CatalogColumn {
  name: string;
  /** The column's type as `format_type` spells it, modifiers included. */
  native: string;
  /** The type's own name, after resolving a domain to its base type. */
  typname: string;
  /** `format_type` of the base type, schema-qualified where `search_path` would need it. */
  castType: string;
  typtype: string;
  category: string;
  /** The element type's name, for an array. */
  element: string | null;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  identity: string;
}

interface CatalogIndex {
  name: string;
  primary: boolean;
  unique: boolean;
  btree: boolean;
  total: boolean;
  notNull: boolean;
  columns: string[];
}

/**
 * What registration knows about a relation it reads and never alters.
 *
 * `key` is the primary key's columns, else those of the unique index that identifies a row as one
 * would; absent when neither exists, which is every view, materialized view and foreign table.
 * `indexes` lists each usable btree index's leading columns, for the declared-index warning.
 */
export interface CatalogRelation {
  kind: string;
  readable: boolean;
  columns: CatalogColumn[];
  key?: string[];
  keyName?: string;
  indexes: string[][];
}

interface RelationRow {
  oid: number;
  kind: string;
  readable: boolean;
}

const RELATION_KINDS = "('r', 'p', 'v', 'm', 'f')";

const RELATION_SQL = `
  SELECT c.oid, c.relkind AS kind, has_table_privilege(c.oid, 'SELECT') AS readable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${RELATION_KINDS}`;

const COLUMNS_SQL = `
  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS native,
    b.typname, format_type(b.oid, NULL) AS "castType", b.typtype, b.typcategory AS category,
    e.typname AS element, a.attnotnull AS "notNull", a.atthasdef AS "hasDefault",
    a.attgenerated <> '' AS generated, a.attidentity AS identity
  FROM pg_attribute a
  JOIN pg_type t ON t.oid = a.atttypid
  JOIN pg_type b ON b.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
  LEFT JOIN pg_type e ON e.oid = b.typelem AND b.typcategory = 'A'
  WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

const INDEXES_SQL = `
  SELECT i.relname AS name, x.indisprimary AS primary, x.indisunique AS unique,
    m.amname = 'btree' AS btree,
    x.indisvalid AND x.indpred IS NULL AND x.indexprs IS NULL AS total,
    NOT EXISTS (
      SELECT 1 FROM unnest(x.indkey::int2[]) k(n)
      JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n
      WHERE NOT a.attnotnull
    ) AS "notNull",
    ARRAY(
      SELECT a.attname::text
      FROM unnest((x.indkey::int2[])[0:x.indnkeyatts - 1]) WITH ORDINALITY k(n, o)
      JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n
      ORDER BY k.o
    ) AS columns
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_am m ON m.oid = i.relam
  WHERE x.indrelid = $1
  ORDER BY i.relname`;

/** A unique index that names a row as a primary key does: total, and over `NOT NULL` columns. */
function IsCandidateKey(index: CatalogIndex): boolean {
  return index.unique && index.total && index.notNull;
}

/** Fewest columns first, then by name, so the same catalog always yields the same key. */
function ByKeyPreference(left: CatalogIndex, right: CatalogIndex): number {
  const width = left.columns.length - right.columns.length;
  return width !== 0 ? width : left.name.localeCompare(right.name);
}

/** The primary key, else the preferred candidate key, else nothing. */
function KeyOf(indexes: CatalogIndex[]): CatalogIndex | undefined {
  const primary = indexes.find((index) => index.primary);
  if (primary) {
    return primary;
  }
  return indexes.filter(IsCandidateKey).sort(ByKeyPreference)[0];
}

function ServingIndexes(indexes: CatalogIndex[]): string[][] {
  return indexes
    .filter((index) => index.btree && index.total)
    .map((index) => index.columns);
}

/**
 * Reads a relation's columns, key and indexes out of `pg_catalog`, or nothing when the schema has
 * no relation of that name. Only the catalog is read, which a role with `USAGE` on the schema may.
 */
export async function ReadRelation(
  schemaName: string,
  relationName: string,
): Promise<CatalogRelation | undefined> {
  const found = await Query<RelationRow>(RELATION_SQL, [
    schemaName,
    relationName,
  ]);
  if (found.rows.length === 0) {
    return undefined;
  }
  const relation = found.rows[0];
  const columns = await Query<CatalogColumn>(COLUMNS_SQL, [relation.oid]);
  const indexes = await Query<CatalogIndex>(INDEXES_SQL, [relation.oid]);
  const key = KeyOf(indexes.rows);
  return {
    kind: relation.kind,
    readable: relation.readable,
    columns: columns.rows,
    key: key?.columns,
    keyName: key?.name,
    indexes: ServingIndexes(indexes.rows),
  };
}
