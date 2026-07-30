import type { PoolConfig } from "pg";

/**
 * How aggressively schema registration is allowed to alter existing tables.
 *
 * - `safe`: create missing schemas, tables, columns and indexes; refuse changes
 *   that could lose data.
 * - `destructive`: additionally allow column type changes and column drops.
 */
export type MigrationMode = "safe" | "destructive";

/**
 * Module configuration, as accepted by `construct`.
 */
export interface Options {
  /** PostgreSQL connection string. */
  url?: string;
  /** Additional `pg.Pool` options, merged over the connection string. */
  pool?: PoolConfig;
  /** Prefix applied to every generated PostgreSQL schema name. */
  schemaPrefix?: string;
  /** Schema convergence policy. Defaults to `safe`. */
  migrations?: MigrationMode;
  /** Rows fetched per round trip when iterating a cursor. */
  cursorBatchSize?: number;
  /** How long an untouched cursor is kept open before being reclaimed. */
  cursorIdleTimeoutMs?: number;
  /** Per-statement timeout applied to every pooled connection. */
  statementTimeoutMs?: number;
}

export interface ResolvedOptions {
  url: string;
  pool: PoolConfig;
  schemaPrefix: string;
  migrations: MigrationMode;
  cursorBatchSize: number;
  cursorIdleTimeoutMs: number;
  statementTimeoutMs?: number;
}

const DEFAULT_URL = "postgres://postgres@localhost:5432/antelopejs";
const DEFAULT_MIGRATIONS: MigrationMode = "safe";
const DEFAULT_SCHEMA_PREFIX = "";
const DEFAULT_CURSOR_BATCH_SIZE = 100;
const DEFAULT_CURSOR_IDLE_TIMEOUT_MS = 60_000;

const NOT_CONFIGURED =
  "PostgreSQL adapter is not configured: construct() has not run yet";

let resolved: ResolvedOptions | undefined;

export function SetOptions(options?: Options): ResolvedOptions {
  resolved = {
    url: options?.url ?? DEFAULT_URL,
    pool: options?.pool ?? {},
    schemaPrefix: options?.schemaPrefix ?? DEFAULT_SCHEMA_PREFIX,
    migrations: options?.migrations ?? DEFAULT_MIGRATIONS,
    cursorBatchSize: options?.cursorBatchSize ?? DEFAULT_CURSOR_BATCH_SIZE,
    cursorIdleTimeoutMs:
      options?.cursorIdleTimeoutMs ?? DEFAULT_CURSOR_IDLE_TIMEOUT_MS,
    statementTimeoutMs: options?.statementTimeoutMs,
  };
  return resolved;
}

export function GetOptions(): ResolvedOptions {
  if (!resolved) {
    throw new Error(NOT_CONFIGURED);
  }
  return resolved;
}

export function ClearOptions() {
  resolved = undefined;
}
