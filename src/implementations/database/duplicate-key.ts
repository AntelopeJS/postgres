import { DatabaseError } from "pg";
import { DuplicateKeyError } from "@antelopejs/interface-database";

import { Query } from "../../connection";
import { IndexFields } from "./ddl";
import { GetTable } from "./schema";
import { ID_COLUMN } from "./utils";
import type { TableOrigin } from "./relation";
import { IndexName, ReplacementIndexName, SchemaName } from "./identifier";

const UNIQUE_VIOLATION = "23505";
const PRIMARY_KEY_FIELDS = [ID_COLUMN];

const IS_PRIMARY_KEY_SQL = `
  SELECT 1 FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`;

/** A declared unique index, by the name the schema gives it and the fields it keys on. */
interface UniqueKey {
  readonly index: string;
  readonly fields: string[];
}

/**
 * The declared unique indexes of a table, by every physical name that can refuse a write: the
 * index's own, and the one its rebuild is staged under, which is unique and live while it builds.
 */
function UniqueKeys(origin: TableOrigin): Map<string, UniqueKey> {
  const indexes = GetTable(origin.schemaId, origin.tableId).indexes ?? {};
  const keys = new Map<string, UniqueKey>();
  for (const [indexId, index] of Object.entries(indexes)) {
    if (index.unique !== true) {
      continue;
    }
    const key = { index: indexId, fields: IndexFields(indexId, index) };
    const name = IndexName(origin.tableId, indexId);
    keys.set(name, key).set(ReplacementIndexName(name), key);
  }
  return keys;
}

/** Read off the catalog, since PostgreSQL chose the name and may have truncated or numbered it. */
async function IsPrimaryKey(schemaName: string, constraint: string) {
  const result = await Query(IS_PRIMARY_KEY_SQL, [schemaName, constraint]);
  return result.rows.length > 0;
}

/**
 * The error a write to a managed table answers when it failed, as the interface's
 * `DuplicateKeyError` when PostgreSQL refused it for a unique violation.
 *
 * The violated constraint is matched against the physical names of the table's declared unique
 * indexes first, then against its primary key, which reports as `_id`. A violation of anything
 * else — an index the adapter did not create — is answered unchanged.
 */
export async function DuplicateKeyFailure(
  err: unknown,
  origin: TableOrigin,
): Promise<unknown> {
  if (!(err instanceof DatabaseError) || err.code !== UNIQUE_VIOLATION) {
    return err;
  }
  const constraint = err.constraint ?? "";
  const declared = UniqueKeys(origin).get(constraint);
  if (declared) {
    return new DuplicateKeyError(declared.index, [...declared.fields]);
  }
  if (await IsPrimaryKey(SchemaName(origin.schemaId), constraint)) {
    return new DuplicateKeyError(ID_COLUMN, [...PRIMARY_KEY_FIELDS]);
  }
  return err;
}
