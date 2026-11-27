import { GetRuntimeInfo } from "@antelopejs/interface-core/runtime";
import { Client, type ClientConfig, type PoolConfig } from "pg";

import {
  type ConnectionSsl,
  IsUnusableSsl,
  type UnusableSsl,
} from "./pg-connection-parameters";

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
   * Rows fetched per round trip when iterating a cursor, and handed over together by one read.
   * Defaults to 1000.
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
  /** External mode only. See {@link InstanceDatabasesOptions}. */
  instanceDatabases?: InstanceDatabasesOptions;
}

/** Where the ids of the schema instances an external module serves come from. */
export interface InstanceListOptions {
  /** The database the query runs in, on the server `url` names. Unset, the database of `url`. */
  database?: string;
  /** A statement whose first column answers one instance id per row. */
  query: string;
}

/**
 * External mode only: a schema instance is a database on the server `url` names.
 *
 * The default instance keeps reading the database of `url`, which is also the one registration
 * reads the catalog from: every instance database is expected to hold the same relations.
 */
export interface InstanceDatabasesOptions {
  /** The database name of an instance, with `{instance}` standing for its id. */
  database: string;
  list: InstanceListOptions;
  /** How many instance pools stay open at once; the least recently used idle one is closed past it. */
  maxOpenPools?: number;
  /** An instance pool no query used for this long is closed. */
  poolIdleMs?: number;
}

export interface ResolvedInstanceDatabases {
  database: string;
  list: InstanceListOptions;
  maxOpenPools: number;
  poolIdleMs: number;
}

export interface ResolvedOptions {
  instanceDatabases?: ResolvedInstanceDatabases;
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
const DEFAULT_CURSOR_BATCH_SIZE = 1000;
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
  supplied: number | undefined,
  fallback: number,
): number {
  if (supplied === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(supplied) || supplied < SMALLEST_POSITIVE_INTEGER) {
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

const URL_SSL_ADVICE =
  "write ssl=true or an sslmode for TLS, ssl=0 or sslmode=disable for none, or ssl=no-verify";

const POOL_SSL_ADVICE =
  "set pool.ssl to true, false or an object of TLS options";

/** One place an `ssl` setting can come from, the config `pg` reads it from, and how to fix it. */
interface SslSource {
  name: string;
  config: ClientConfig;
  advice: string;
}

function IsText(ssl: UnusableSsl): ssl is string {
  return typeof ssl === "string";
}

/** Text quoted, so `"false"` cannot be read as the boolean the advice asks for. */
function Described(ssl: UnusableSsl): string {
  return IsText(ssl) ? JSON.stringify(ssl) : String(ssl);
}

/**
 * The `ssl` setting `pg` would connect with under `config` when it is one `pg` cannot use, read
 * from `pg`'s own connection parameters after every conversion it makes. Once the server accepts
 * TLS, `pg` throws on such a setting inside a socket event, where no promise catches it and the
 * process exits. The client is built without the config's `stream`, which `pg` would call and
 * which the parameters never read; it never connects. A config `pg` cannot read is left for `pg`
 * to refuse at connect, as it always has.
 */
function UnusableSsl(config: ClientConfig): string | undefined {
  let ssl: ConnectionSsl;
  try {
    ssl = new Client({ ...config, stream: undefined }).connectionParameters.ssl;
  } catch {
    return undefined;
  }
  return IsUnusableSsl(ssl) ? Described(ssl) : undefined;
}

/**
 * Where an `ssl` setting can come from, in the order to blame them: `url` alone, as the change-feed
 * listener connects; `pool.connectionString`, which replaces `url` in the pool; and `url` with `pool`
 * merged over it, as the pool connects.
 */
function SslSources(url: string, pool: PoolConfig): SslSource[] {
  const sources: SslSource[] = [
    {
      name: "config.url sets ssl to ",
      config: { connectionString: url },
      advice: URL_SSL_ADVICE,
    },
  ];
  if (pool.connectionString) {
    sources.push({
      name: "config.pool.connectionString sets ssl to ",
      config: { connectionString: pool.connectionString },
      advice: URL_SSL_ADVICE,
    });
  }
  sources.push({
    name: "config.pool.ssl is ",
    config: { connectionString: url, ...pool },
    advice: POOL_SSL_ADVICE,
  });
  return sources;
}

/** Refuses an `ssl` setting `pg` would end the process on, naming where it comes from. */
function AssertUsableSsl(url: string, pool: PoolConfig): void {
  for (const { name, config, advice } of SslSources(url, pool)) {
    const unusable = UnusableSsl(config);
    if (unusable !== undefined) {
      throw new Error(`${name}${unusable}, which pg cannot use: ${advice}`);
    }
  }
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

const INSTANCE_PLACEHOLDER = "{instance}";
const DEFAULT_MAX_OPEN_POOLS = 10;
const DEFAULT_POOL_IDLE_MS = 60_000;

function IsFilledText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function ResolveInstanceDatabases(
  mode: Mode,
  options?: Options,
): ResolvedInstanceDatabases | undefined {
  const supplied = options?.instanceDatabases;
  if (supplied === undefined) {
    return undefined;
  }
  if (mode !== "external") {
    throw new Error(
      `instanceDatabases cannot be set with mode "owned": an owned instance keeps every schema instance in the database of its url`,
    );
  }
  if (
    !IsFilledText(supplied.database) ||
    !supplied.database.includes(INSTANCE_PLACEHOLDER)
  ) {
    throw new Error(
      `instanceDatabases.database must be a database name holding ${INSTANCE_PLACEHOLDER}, received ${JSON.stringify(supplied.database)}`,
    );
  }
  if (!IsFilledText(supplied.list?.query)) {
    throw new Error(
      "instanceDatabases.list.query must be a statement answering one instance id per row: without it no id could be told from an arbitrary database name",
    );
  }
  if (
    supplied.list.database !== undefined &&
    !IsFilledText(supplied.list.database)
  ) {
    throw new Error(
      "instanceDatabases.list.database must be a database name; leave it out to run the list query in the database of url",
    );
  }
  return {
    database: supplied.database,
    list: { database: supplied.list.database, query: supplied.list.query },
    maxOpenPools: PositiveSafeInteger(
      "instanceDatabases.maxOpenPools",
      supplied.maxOpenPools,
      DEFAULT_MAX_OPEN_POOLS,
    ),
    poolIdleMs: PositiveSafeInteger(
      "instanceDatabases.poolIdleMs",
      supplied.poolIdleMs,
      DEFAULT_POOL_IDLE_MS,
    ),
  };
}

export function SetOptions(options?: Options): ResolvedOptions {
  const mode = ResolveMode(options);
  const url = ResolveUrl(mode, options);
  AssertUsableSsl(url, options?.pool ?? {});
  resolved = {
    instanceDatabases: ResolveInstanceDatabases(mode, options),
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

/**
 * Whether schema instances are databases here, which only an external instance can be told.
 *
 * Answers `false` before `construct()` rather than refusing: the compiler asks it for every external
 * root, and a statement compiled with no options set has no instance database to route to.
 */
export function HasInstanceDatabases(): boolean {
  return resolved?.instanceDatabases !== undefined;
}

/** Whether the catalog answers: `catalog.enabled` when set, and otherwise the project's development mode. */
export async function IsCatalogEnabled(): Promise<boolean> {
  const configured = GetOptions().catalog.enabled;
  return configured ?? (await GetRuntimeInfo()).dev;
}

export function ClearOptions() {
  resolved = undefined;
}
