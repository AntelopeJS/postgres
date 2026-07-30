import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { ClearOptions, GetOptions, type Options, SetOptions } from "./config";

const NOT_CONNECTED =
  "PostgreSQL adapter is not connected: construct() has not run yet";

let pool: Pool | undefined;

/**
 * Opens the connection pool and verifies the server is reachable.
 *
 * Called before any interface is implemented so no query can observe a
 * half-initialized pool.
 */
export async function Connect(options?: Options) {
  await Disconnect();
  const resolved = SetOptions(options);
  const created = new Pool({
    connectionString: resolved.url,
    statement_timeout: resolved.statementTimeoutMs,
    ...resolved.pool,
  });
  try {
    const client = await created.connect();
    client.release();
  } catch (err) {
    await created.end();
    ClearOptions();
    throw err;
  }
  pool = created;
}

export async function Disconnect() {
  const current = pool;
  pool = undefined;
  ClearOptions();
  if (current) {
    await current.end();
  }
}

export function IsConnected() {
  return pool !== undefined;
}

export function GetPool(): Pool {
  if (!pool) {
    throw new Error(NOT_CONNECTED);
  }
  return pool;
}

export function Query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return GetPool().query<T>(sql, params as never);
}

/**
 * Takes a client out of the pool for the caller to own.
 *
 * Used by cursors, which need a stable session for the lifetime of the
 * transaction holding them. The caller is responsible for releasing it.
 */
export function AcquireClient(): Promise<PoolClient> {
  return GetPool().connect();
}

export function GetSchemaPrefix() {
  return GetOptions().schemaPrefix;
}
