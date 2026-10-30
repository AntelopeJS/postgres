import {
  type ClientBase,
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { Logger } from "./logger";
import { ClearOptions, GetOptions, type Options, SetOptions } from "./config";

const NOT_CONNECTED =
  "PostgreSQL adapter is not connected: construct() has not run yet";

const SESSION_SETTINGS = "SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, MDY'";

const CLIENT_ERROR = "error";

const HELD_CLIENT_FAILED =
  "the connection under a borrowed PostgreSQL client failed while it was checked out";

const IDLE_CLIENT_FAILED =
  "the connection under an idle pooled PostgreSQL client failed";

const CONNECTED = "connected to PostgreSQL";

const DISCONNECTED = "disconnected from PostgreSQL";

const SLOW_ACQUIRE_MS = 10_000;

/**
 * Says what a caller that is merely blocked cannot say for itself, since the wait has no deadline.
 *
 * It names the symptom and stops there. `pg-pool` queues only once the pool is full and otherwise
 * opens a new connection, so this same wait covers both a pool held by cursors still being iterated
 * and a server that is simply not answering — and nothing here can tell those apart. Naming one
 * would send an operator after the wrong thing, and this is the only line the adapter emits for
 * either.
 */
const SLOW_ACQUIRE = `no PostgreSQL client has become available in ${SLOW_ACQUIRE_MS} ms: either every pooled connection is checked out — a cursor holds one for as long as it is iterated — or a new connection is not being answered. Raise pool.max, or set pool.connectionTimeoutMillis to fail rather than wait`;

let pool: Pool | undefined;
let isWaiting = false;

export type BeforeDisconnect = () => void | PromiseLike<void>;

export type PoolTeardown = () => Promise<void>;

const beforeDisconnect = new Set<BeforeDisconnect>();

function PinSession(client: ClientBase) {
  return client.query(SESSION_SETTINGS);
}

/** Turns a callback's synchronous throw into a rejection, which is all `allSettled` can absorb. */
async function Invoke(callback: BeforeDisconnect) {
  return callback();
}

/** Swallows an idle client's failure — see {@link GuardPool}, which owns why the pool needs one. */
function ReportIdleClientError(err: Error) {
  Logger.Warn(IDLE_CLIENT_FAILED, err);
}

/**
 * Gives the pool the `error` listener it does not carry by default.
 *
 * This is {@link GuardHeldClient}'s rule at the other end of a client's life, and it is a second
 * listener rather than the same one because the two cover disjoint windows. `pg-pool` removes its
 * idle listener on checkout and re-attaches it on release, and *that* listener re-emits on the pool
 * itself — so a connection that dies while its client sits idle **in** the pool arrives as
 * `pool.emit("error", …)`, with no query in flight and nothing of this module's on the stack. A
 * failover, an `idle_session_timeout`, an administrative `pg_terminate_backend` and a dropped
 * socket all reach it. An `error` event on an `EventEmitter` with no listener is an unhandled
 * exception, so an adapter that guards only its borrowed clients still ends the host process for an
 * event it could have logged.
 *
 * Swallowing is the whole handling, for {@link GuardHeldClient}'s reason: the pool discards a
 * broken client on its own, and the next caller is handed a working one. Nothing is un-listened,
 * because the pool outlives every client it lends and is discarded whole by {@link Disconnect}.
 *
 * Exported so a spec can drive it with a bare `EventEmitter`, exactly as the held-client guard is
 * driven — `Connect` builds a real pool and cannot be reached without a server.
 */
export function GuardPool(created: Pool): Pool {
  created.on(CLIENT_ERROR, ReportIdleClientError);
  return created;
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
 *
 * The pool is guarded before it is verified — see {@link GuardPool} — because the verification
 * acquisition below can itself be the first thing that fails.
 */
export async function Connect(options?: Options) {
  await Disconnect();
  const resolved = SetOptions(options);
  const created = GuardPool(
    new Pool({
      connectionString: resolved.url,
      statement_timeout: resolved.statementTimeoutMs,
      ...resolved.pool,
      onConnect: PinSession,
    }),
  );
  try {
    const client = await created.connect();
    client.release();
  } catch (err) {
    await created.end();
    ClearOptions();
    throw err;
  }
  pool = created;
  Logger.Info(CONNECTED);
}

/**
 * Registers a callback to be settled before the pool is ended, and answers a function that
 * withdraws it again.
 *
 * `pool.end()` was measured not to resolve while a client is checked out — it hung past a
 * 1500 ms deadline — so anything holding a pooled client past the end of a single query, which
 * is what a cursor's transaction does, has to give it back before the pool closes or both
 * `destroy()` and the `Disconnect()` inside `Connect()` never return. The holders sit below this
 * module and import from it, so the dependency is inverted through this registry rather than
 * spelled as an import back.
 *
 * A registration outlives a `Connect`/`Disconnect` cycle: a module that registers at load time is
 * still registered after a reconnect.
 */
export function RegisterBeforeDisconnect(callback: BeforeDisconnect) {
  beforeDisconnect.add(callback);
  return () => {
    beforeDisconnect.delete(callback);
  };
}

/**
 * Settles every registered callback, then runs `endPool`.
 *
 * A callback that throws or rejects must not keep the pool open — a cursor whose close failed is
 * a worse leak if it also blocks `pool.end()` — so the outcomes are settled and discarded rather
 * than raced.
 *
 * `Disconnect` is its only production caller. It is a seam because a spec cannot drive
 * `Disconnect` itself: that replaces the `pool` singleton a live adapter in the same process is
 * still querying through, while this takes the teardown as an argument and touches
 * no module state.
 */
export async function SettleBeforeDisconnect(endPool: PoolTeardown) {
  await Promise.allSettled([...beforeDisconnect].map(Invoke));
  await endPool();
}

async function EndPool() {
  const current = pool;
  pool = undefined;
  ClearOptions();
  if (current) {
    await current.end();
    Logger.Info(DISCONNECTED);
  }
}

/** Settles every `RegisterBeforeDisconnect` callback, then ends the pool and forgets the options. */
export async function Disconnect() {
  await SettleBeforeDisconnect(EndPool);
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
  return GetPool().query<T>(sql, params);
}

function ReportHeldClientError(err: Error) {
  Logger.Warn(HELD_CLIENT_FAILED, err);
}

/** Warns once per episode of waiting, however many callers are queued behind the same one. */
function WarnSlowAcquire() {
  if (isWaiting) {
    return;
  }
  isWaiting = true;
  Logger.Warn(SLOW_ACQUIRE);
}

/**
 * Gives a checked-out client the `error` listener the pool takes away, and takes it back off when
 * the client is handed in.
 *
 * `pg-pool` removes its own idle listener the moment a client is checked out and re-attaches it on
 * release, and `pool.query` covers that gap by attaching one for the duration of the query. A
 * client borrowed through `AcquireClient` is inside the same gap for as long as its borrower holds
 * it and gets neither, so its `listenerCount("error")` is zero — and an `error` event on an
 * `EventEmitter` with no listener is an unhandled exception, which ends the process. A cursor is a
 * session idle *in a transaction* for up to `cursorIdleTimeoutMs`, which is precisely what
 * `idle_in_transaction_session_timeout`, a failover and an administrative `pg_terminate_backend`
 * each end: measured against a server set to 800 ms, `25P03` and `Connection terminated
 * unexpectedly` both arrived uncaught and the process exited 1.
 *
 * **Swallowing the event is the whole handling, and deliberately.** The borrower discovers the
 * failure on its next statement — *client is not queryable* — which is where it can act on it, and
 * every path downstream of that was measured already correct: buffered rows are still served, the
 * cursor's teardown runs, its client comes back, and the next unrelated query succeeds. The event
 * is logged rather than dropped because a connection dying under a held client is worth a line.
 *
 * **The listener has to come off before the client does, and the wrapper has to be applied per
 * acquisition.** A pooled client is reused, so a listener left attached accumulates one per
 * checkout — three on one client, measured. `pg-pool` *reassigns* `client.release` on every
 * checkout, so a wrapper installed once per client would be thrown away by the next one; this
 * wraps whatever `release` the current checkout installed, forwards every argument to it, and puts
 * it back.
 */
export function GuardHeldClient(client: PoolClient): PoolClient {
  const checkin = client.release;
  client.on(CLIENT_ERROR, ReportHeldClientError);
  client.release = (...args: Parameters<PoolClient["release"]>) => {
    client.off(CLIENT_ERROR, ReportHeldClientError);
    client.release = checkin;
    return checkin.apply(client, args);
  };
  return client;
}

/**
 * Takes a client out of the pool for the caller to own.
 *
 * Used by cursors, which need a stable session for the lifetime of the
 * transaction holding them, and by the migration planner. The caller is
 * responsible for releasing it.
 *
 * Every borrowed client is handed back guarded — see `GuardHeldClient`, which owns why a client
 * held outside a query has to carry an `error` listener of its own.
 *
 * A cursor holds its client for as long as it is iterated, so `pool.max` concurrent iterations
 * leave the next acquisition waiting — with `pg`'s own `connectionTimeoutMillis` of 0, waiting
 * without a deadline. That wait is legitimate and usually ends when a cursor finishes or is
 * reclaimed, so it is not shortened here; but a caller blocked inside it can say nothing about
 * why, which is what {@link SLOW_ACQUIRE} is for. The timer is `unref`'d so it cannot hold the
 * event loop open, and cleared however the acquisition settles.
 *
 * **One line per episode, not per caller.** A saturated pool blocks every acquisition behind it, so
 * a per-call warning answers a single stuck cursor with one line per waiting reader and another for
 * every read that arrives while it lasts. The flag latches on the first warning and clears on the
 * next acquisition to settle, which is the same edge the reaper reports its failures on.
 */
export function AcquireClient(): Promise<PoolClient> {
  const current = GetPool();
  const slow = setTimeout(WarnSlowAcquire, SLOW_ACQUIRE_MS);
  slow.unref();
  return current
    .connect()
    .then(GuardHeldClient)
    .finally(() => {
      clearTimeout(slow);
      isWaiting = false;
    });
}

export function GetSchemaPrefix() {
  return GetOptions().schemaPrefix;
}
