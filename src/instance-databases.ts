import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { GetOptions, type ResolvedInstanceDatabases } from "./config";
import {
  AcquireClient,
  CreatePool,
  GetPool,
  GuardHeldClient,
  Query,
  RegisterBeforeDisconnect,
} from "./connection";
import { Logger } from "./logger";

/** An open pool on one database of the server, and when a query last went through it. */
interface OpenPool {
  pool: Pool;
  usedAt: number;
  checks: Map<string, InstanceCheck>;
}

/** Whether one registered schema was found in an instance database, and when it was not. */
export interface InstanceCheck {
  result: Promise<void>;
  failedAt?: number;
}

/** The database an instance reads, its pool, and what was verified of it since the pool opened. */
export interface InstanceTarget {
  instance: string;
  database: string;
  pool: Pool;
  checks: Map<string, InstanceCheck>;
}

/** The instance ids the list query answered, and when. */
interface Listing {
  ids: readonly string[];
  readAt: number;
}

const INSTANCE_PLACEHOLDER = "{instance}";

const NOT_CONFIGURED =
  "instanceDatabases is not configured, so a schema instance names no database";

/** How long a listing answers membership before the list query runs again. */
const LISTING_TTL_MS = 30_000;

/** An unknown id re-reads the list at most this often, so a wrong id cannot become a query storm. */
const LISTING_RETRY_MS = 1_000;

const CAP_EXCEEDED =
  "every instance pool is in use, so one more is opened past instanceDatabases.maxOpenPools; raise it, or lower pool.max, if the server runs out of connections";

const pools = new Map<string, OpenPool>();
let listing: Listing | undefined;
let pendingListing: Promise<Listing> | undefined;
let sweeper: NodeJS.Timeout | undefined;

function Settings(): ResolvedInstanceDatabases {
  const settings = GetOptions().instanceDatabases;
  if (!settings) {
    throw new Error(NOT_CONFIGURED);
  }
  return settings;
}

/**
 * The connection string of another database on the server the module connects to.
 *
 * Only the path changes: credentials, host, port and every option of the URL are the ones the
 * default pool uses, which is what makes an instance database the same connection elsewhere.
 */
function DatabaseUrl(database: string): string {
  const options = GetOptions();
  const target = new URL(options.pool.connectionString ?? options.url);
  target.pathname = `/${encodeURIComponent(database)}`;
  return target.toString();
}

function IsIdle(open: OpenPool): boolean {
  return (
    open.pool.totalCount === open.pool.idleCount && open.pool.waitingCount === 0
  );
}

function Close(database: string, open: OpenPool): void {
  pools.delete(database);
  open.pool.end().catch((err: unknown) => {
    Logger.Warn(`closing the pool of database '${database}' failed`, err);
  });
}

/** Closes the least recently used pool that holds no client, when there is one. */
function EvictOne(): boolean {
  let oldest: [string, OpenPool] | undefined;
  for (const entry of pools) {
    if (IsIdle(entry[1]) && (!oldest || entry[1].usedAt < oldest[1].usedAt)) {
      oldest = entry;
    }
  }
  if (!oldest) {
    return false;
  }
  Close(oldest[0], oldest[1]);
  return true;
}

function Sweep(): void {
  const settings = GetOptions().instanceDatabases;
  const deadline = Date.now() - (settings?.poolIdleMs ?? 0);
  for (const [database, open] of pools) {
    if (IsIdle(open) && open.usedAt <= deadline) {
      Close(database, open);
    }
  }
  if (pools.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function StartSweeper(poolIdleMs: number): void {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(Sweep, poolIdleMs);
  sweeper.unref();
}

/**
 * Answers the pool of a database of the server, opening it on first use.
 *
 * A pool that holds a client is never closed to make room: a cursor keeps its client for as long as
 * it is iterated. When every pool is in use the cap is exceeded with a warning rather than made a
 * wait nobody bounded.
 */
function Open(database: string): OpenPool {
  const settings = Settings();
  const known = pools.get(database);
  if (known) {
    known.usedAt = Date.now();
    return known;
  }
  if (pools.size >= settings.maxOpenPools && !EvictOne()) {
    Logger.Warn(CAP_EXCEEDED);
  }
  const opened: OpenPool = {
    pool: CreatePool(DatabaseUrl(database)),
    usedAt: Date.now(),
    checks: new Map(),
  };
  pools.set(database, opened);
  StartSweeper(settings.poolIdleMs);
  return opened;
}

function PoolOf(database: string): Pool {
  return Open(database).pool;
}

/**
 * The database of a listed instance with its pool, for a caller that verifies it before reading.
 *
 * `checks` lives as long as the pool: a pool closed for idleness forgets them, so a database is
 * verified again the next time it is opened.
 */
export async function OpenInstance(instance: string): Promise<InstanceTarget> {
  const database = await DatabaseOf(instance);
  const opened = Open(database);
  return { instance, database, pool: opened.pool, checks: opened.checks };
}

function FirstColumn(row: QueryResultRow): string {
  return String(Object.values(row)[0]);
}

async function ReadListing(): Promise<Listing> {
  const settings = Settings();
  const source = settings.list.database
    ? PoolOf(settings.list.database)
    : GetPool();
  const result = await source.query(settings.list.query);
  return { ids: result.rows.map(FirstColumn), readAt: Date.now() };
}

/** Reads the list once for every caller waiting on it. */
function RefreshListing(): Promise<Listing> {
  pendingListing ??= ReadListing()
    .then((read) => {
      listing = read;
      return read;
    })
    .finally(() => {
      pendingListing = undefined;
    });
  return pendingListing;
}

async function CurrentListing(): Promise<Listing> {
  if (listing && Date.now() - listing.readAt < LISTING_TTL_MS) {
    return listing;
  }
  return RefreshListing();
}

/** Every instance id the list query answers, read again on each call. */
export async function ListInstanceIds(): Promise<string[]> {
  return [...(await RefreshListing()).ids];
}

/**
 * The database of an instance, refused unless the list query answers its id.
 *
 * The id reaches a database name, so it is never taken on the caller's word: an id the listing does
 * not hold is looked for once more in a fresh listing, for an instance created since, then refused.
 */
async function DatabaseOf(instance: string): Promise<string> {
  const settings = Settings();
  let current = await CurrentListing();
  if (
    !current.ids.includes(instance) &&
    Date.now() - current.readAt >= LISTING_RETRY_MS
  ) {
    current = await RefreshListing();
  }
  if (!current.ids.includes(instance)) {
    throw new Error(
      `Instance '${instance}' is not one that instanceDatabases.list.query answers, so it names no database`,
    );
  }
  return settings.database.replaceAll(INSTANCE_PLACEHOLDER, instance);
}

/** Runs a statement in the database of `instance`, or in the database of `url` when it names none. */
export async function QueryInstance<T extends QueryResultRow = QueryResultRow>(
  instance: string | undefined,
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  if (instance === undefined) {
    return Query<T>(sql, params);
  }
  return PoolOf(await DatabaseOf(instance)).query<T>(sql, params);
}

/** Takes a client the caller owns, as `AcquireClient` does, from the database of `instance`. */
export async function AcquireInstanceClient(
  instance: string | undefined,
): Promise<PoolClient> {
  if (instance === undefined) {
    return AcquireClient();
  }
  const pool = PoolOf(await DatabaseOf(instance));
  return GuardHeldClient(await pool.connect());
}

/** Ends every instance pool and forgets the listing; the default pool is `Disconnect`'s. */
async function CloseInstancePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  listing = undefined;
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
  await Promise.allSettled(open.map((entry) => entry.pool.end()));
}

RegisterBeforeDisconnect(CloseInstancePools);
