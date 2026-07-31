import {
  type ClientBase,
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { ClearOptions, GetOptions, type Options, SetOptions } from "./config";

const NOT_CONNECTED =
  "PostgreSQL adapter is not connected: construct() has not run yet";

const SESSION_SETTINGS = "SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, MDY'";

let pool: Pool | undefined;

function PinSession(client: ClientBase) {
  return client.query(SESSION_SETTINGS);
}

/**
 * Opens the connection pool and verifies the server is reachable.
 *
 * Called before any interface is implemented so no query can observe a
 * half-initialized pool.
 *
 * Every pooled connection is pinned to `TimeZone = 'UTC'` and
 * `DateStyle = 'ISO, MDY'` before it is handed out. Both are read by
 * `timestamptz_in`, so a stored string carrying no offset — `2023-01-15` in a
 * `text` column read as a date — resolves to a different instant on a server
 * set to `America/New_York`, and an ambiguous numeric date — `01/02/2023` —
 * resolves to a different month under `DateStyle = 'German, DMY'`. No single
 * expression can branch on whether its input carries an offset, so unlike the
 * extractions, which name their zone explicitly, this one has to be pinned on
 * the session. Pinning through `onConnect` rather than the pool's `connect`
 * event is what keeps a failure from leaving a half-initialized client in the
 * pool: the pool ends that client and rejects the acquisition, which the
 * verification below turns into a failed `construct()`.
 */
export async function Connect(options?: Options) {
  await Disconnect();
  const resolved = SetOptions(options);
  const created = new Pool({
    connectionString: resolved.url,
    statement_timeout: resolved.statementTimeoutMs,
    ...resolved.pool,
    onConnect: PinSession,
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
