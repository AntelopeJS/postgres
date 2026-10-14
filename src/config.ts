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
 * Whose tables an instance serves.
 *
 * - `owned`: the adapter creates and converges the tables it is given, and keeps its own
 *   bookkeeping beside them.
 * - `external`: the tables already exist in a database the adapter does not own. Schema, table and
 *   field names are the database's own, read verbatim; registration reads the catalog and never
 *   runs DDL; rows are read and written, never the structure. `url` is required. See
 *   `docs/external-mode.md`.
 */
export type Mode = "owned" | "external";

/** Whether an external instance answers `@antelopejs/interface-database-catalog`. */
export interface CatalogOptions {
  /**
   * Force the catalog on or off. Unset, it follows the project's development mode: on under
   * `ajs project dev` and `ajs project run`, off under `ajs project start`. The catalog describes
   * and profiles the client's database for a generator, which is development work.
   */
  enabled?: boolean;
}

/**
 * Module configuration, as accepted by `construct`.
 */
export interface Options {
  /** Whose tables this instance serves. Defaults to `owned`. */
  mode?: Mode;
  /** PostgreSQL connection string. */
  url?: string;
  /** Additional `pg.Pool` options, merged over the connection string. */
  pool?: PoolConfig;
  /** Prefix applied to every generated PostgreSQL schema name. */
  schemaPrefix?: string;
  /** Schema convergence policy. Defaults to `safe`. */
  migrations?: MigrationMode;
  /**
   * Rows fetched per round trip when iterating a cursor. Defaults to 100.
   *
   * Refused unless it is a positive safe integer, where every other number here is taken as given:
   * `FETCH FORWARD $1` is a syntax error (`42601`), so this one is interpolated into the statement
   * text as a literal, and an unvalidated value is arbitrary SQL reaching the server through the
   * configuration surface.
   */
  cursorBatchSize?: number;
  /**
   * How long an untouched cursor is kept open before being reclaimed. Defaults to 60000.
   *
   * Validated like {@link Options.cursorBatchSize} so the cursor options refuse the same values,
   * though this one never reaches SQL.
   */
  cursorIdleTimeoutMs?: number;
  /** Per-statement timeout applied to every pooled connection. */
  statementTimeoutMs?: number;
  /**
   * How long a change event stays in the log before it is reaped. Defaults to 300000.
   *
   * This is a contract rather than a tuning parameter: it is the answer to *how long may a
   * consumer stall before its feed is ended*. A feed whose watermark falls below what the reaper
   * has already deleted is rejected with an error naming the gap, so shortening this shortens the
   * time a stalled consumer has before it is ended rather than quietly desynchronised.
   *
   * Validated like {@link Options.cursorBatchSize}, and for a related reason: it reaches an
   * interval, and an unvalidated value is arbitrary SQL arriving through the configuration surface.
   */
  changeRetentionMs?: number;
  /** Change events read from the log per round trip. Defaults to 256. */
  changeBatchSize?: number;
  /**
   * How often a feed polls the log regardless of notifications. Defaults to 5000.
   *
   * This is the fallback rather than the primary wakeup — `NOTIFY` is what makes a feed prompt,
   * and this is what bounds the failure of a listener connection that dies without erroring.
   */
  changePollIntervalMs?: number;
  /** The catalog an external instance answers. See {@link CatalogOptions}. */
  catalog?: CatalogOptions;
}

export interface ResolvedOptions {
  mode: Mode;
  url: string;
  pool: PoolConfig;
  schemaPrefix: string;
  migrations: MigrationMode;
  cursorBatchSize: number;
  cursorIdleTimeoutMs: number;
  statementTimeoutMs?: number;
  changeRetentionMs: number;
  changeBatchSize: number;
  changePollIntervalMs: number;
  catalog: CatalogOptions;
}

const DEFAULT_URL = "postgres://postgres@localhost:5432/antelopejs";
const DEFAULT_MODE: Mode = "owned";
const MODES: readonly Mode[] = ["owned", "external"];

/**
 * The options that configure what only an owned instance does: its own schema names, its DDL, and
 * its change log. An external instance refuses them by name rather than ignoring them, since an
 * option accepted and never applied reads as one that took effect.
 */
const OWNED_ONLY_OPTIONS: readonly (keyof Options)[] = [
  "schemaPrefix",
  "migrations",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
];
const DEFAULT_MIGRATIONS: MigrationMode = "safe";
const DEFAULT_SCHEMA_PREFIX = "";
const DEFAULT_CURSOR_BATCH_SIZE = 100;
const DEFAULT_CURSOR_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CHANGE_RETENTION_MS = 300_000;
const DEFAULT_CHANGE_BATCH_SIZE = 256;
const DEFAULT_CHANGE_POLL_INTERVAL_MS = 5_000;

const SMALLEST_POSITIVE_INTEGER = 1;

const NOT_CONFIGURED =
  "PostgreSQL adapter is not configured: construct() has not run yet";

let resolved: ResolvedOptions | undefined;

/** A supplied option read as a positive safe integer, refused otherwise — see {@link Options.cursorBatchSize}. */
function PositiveSafeInteger(
  option: string,
  supplied: unknown,
  fallback: number,
): number {
  if (supplied === undefined) {
    return fallback;
  }
  if (
    typeof supplied !== "number" ||
    !Number.isSafeInteger(supplied) ||
    supplied < SMALLEST_POSITIVE_INTEGER
  ) {
    throw new Error(
      `${option} must be a positive safe integer, received ${String(supplied)}`,
    );
  }
  return supplied;
}

function ResolveMode(options?: Options): Mode {
  const mode = options?.mode ?? DEFAULT_MODE;
  if (!MODES.includes(mode)) {
    throw new Error(
      `mode must be one of ${MODES.join(", ")}, received ${String(mode)}`,
    );
  }
  if (mode === "external") {
    const refused = OWNED_ONLY_OPTIONS.filter(
      (option) => options?.[option] !== undefined,
    );
    if (refused.length > 0) {
      throw new Error(
        `${refused.join(", ")} cannot be set with mode "external": an external instance owns no schemas, runs no DDL and keeps no change log`,
      );
    }
  }
  return mode;
}

function ResolveUrl(mode: Mode, options?: Options): string {
  if (options?.url !== undefined && options.url.trim() !== "") {
    return options.url;
  }
  if (mode === "external") {
    throw new Error(
      `mode "external" needs a non-empty config.url; set it through the project's envOverrides`,
    );
  }
  return DEFAULT_URL;
}

export function SetOptions(options?: Options): ResolvedOptions {
  const mode = ResolveMode(options);
  const url = ResolveUrl(mode, options);
  resolved = {
    mode,
    url,
    pool: options?.pool ?? {},
    schemaPrefix: options?.schemaPrefix ?? DEFAULT_SCHEMA_PREFIX,
    migrations: options?.migrations ?? DEFAULT_MIGRATIONS,
    cursorBatchSize: PositiveSafeInteger(
      "cursorBatchSize",
      options?.cursorBatchSize,
      DEFAULT_CURSOR_BATCH_SIZE,
    ),
    cursorIdleTimeoutMs: PositiveSafeInteger(
      "cursorIdleTimeoutMs",
      options?.cursorIdleTimeoutMs,
      DEFAULT_CURSOR_IDLE_TIMEOUT_MS,
    ),
    statementTimeoutMs: options?.statementTimeoutMs,
    changeRetentionMs: PositiveSafeInteger(
      "changeRetentionMs",
      options?.changeRetentionMs,
      DEFAULT_CHANGE_RETENTION_MS,
    ),
    changeBatchSize: PositiveSafeInteger(
      "changeBatchSize",
      options?.changeBatchSize,
      DEFAULT_CHANGE_BATCH_SIZE,
    ),
    changePollIntervalMs: PositiveSafeInteger(
      "changePollIntervalMs",
      options?.changePollIntervalMs,
      DEFAULT_CHANGE_POLL_INTERVAL_MS,
    ),
    catalog: options?.catalog ?? {},
  };
  return resolved;
}

export function GetOptions(): ResolvedOptions {
  if (!resolved) {
    throw new Error(NOT_CONFIGURED);
  }
  return resolved;
}

/** Whether the configured instance serves tables it does not own. */
export function IsExternal(): boolean {
  return GetOptions().mode === "external";
}

export function ClearOptions() {
  resolved = undefined;
}
