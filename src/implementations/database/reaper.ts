import type { ClientBase } from "pg";
import { GetOptions } from "../../config";
import { AcquireClient, RegisterBeforeDisconnect } from "../../connection";
import { Logger } from "../../logger";
import {
  CREATED_COLUMN,
  EPOCH_COLUMN,
  HIGH_WATER_COLUMN,
  LOG,
  REAPED,
  SEQ_COLUMN,
  SINGLETON_COLUMN,
} from "./changes";
import { CHANGE_LOG_TABLE, REGISTRY_SCHEMA } from "./utils";

/**
 * The advisory lock every reaping process contends for.
 *
 * An arbitrary constant, and a literal rather than a digest of a name so that a `pg_locks` row is
 * greppable back to this line when someone is looking at a live server. `pg_try_advisory_lock`
 * counts within a session — a second call in one session also succeeds, measured — so a pass takes
 * it once and gives it back once, and a pass that cannot take it does nothing rather than waiting.
 */
const REAP_LOCK_KEY = "7623941058273641";

/** How many passes a retention window gets, so the log holds at most about one and a half of them. */
const PASSES_PER_WINDOW = 2;

/** A retention short enough to divide below this is still worth one pass per timer tick. */
const SHORTEST_INTERVAL_MS = 1;

const RETENTION_PARAM = "$1";
const LOCK_PARAM = "$1";
const REGCLASS_PARAM = "$1";

const LOG_REGCLASS = `${REGISTRY_SCHEMA}.${CHANGE_LOG_TABLE}`;

const PRESENT = `SELECT to_regclass(${REGCLASS_PARAM}) IS NOT NULL AS "present"`;
const TAKE_LOCK = `SELECT pg_try_advisory_lock(${LOCK_PARAM}) AS "took"`;
const RELEASE_LOCK = `SELECT pg_advisory_unlock(${LOCK_PARAM})`;

/**
 * One pass: delete everything past its retention, and record the highest `seq` that went.
 *
 * The high-water is recorded rather than inferred, and that is the whole of what turns *did I lose
 * anything* from a guess into a read. A log holding only rows above a feed's watermark is the
 * **normal** state of a quiet table, and it is also exactly what a reaped log looks like, so
 * `min(seq)` cannot tell the two apart.
 *
 * **The epoch column is what keeps the high-water comparable to the log beside it.** The log is
 * `UNLOGGED`, so an unclean shutdown empties it and restarts `seq` at 1 while this permanent row
 * keeps a high-water from the previous life of the sequence — measured: a `SIGKILL`ed server came
 * back with an empty log counting from 1 and a stored high-water of 8, which would put every feed
 * opened afterwards permanently below it and reject them all with a gap that never happened. So a
 * pass raises the high-water only within one `pg_postmaster_start_time()`, and starts a new epoch's
 * high-water from what that pass itself deleted. A *clean* restart preserves both the table and the
 * sequence — also measured, and the reason this is an epoch check rather than an emptiness check —
 * but resetting is right there too: the events the old high-water described are ones no surviving
 * feed is still entitled to, since a feed that spans a restart is ended by its own guard.
 *
 * One statement, so a pass that dies between the delete and the record is impossible.
 */
const REAP = `WITH "reaped" AS (
  DELETE FROM ${LOG}
   WHERE ${CREATED_COLUMN} < now() - (${RETENTION_PARAM}::bigint * interval '1 millisecond')
  RETURNING ${SEQ_COLUMN}
)
INSERT INTO ${REAPED} AS "r" (${SINGLETON_COLUMN}, ${HIGH_WATER_COLUMN}, ${EPOCH_COLUMN})
SELECT true, COALESCE(max(${SEQ_COLUMN}), 0), pg_postmaster_start_time() FROM "reaped"
ON CONFLICT (${SINGLETON_COLUMN}) DO UPDATE SET
  ${HIGH_WATER_COLUMN} = CASE
    WHEN "r".${EPOCH_COLUMN} = EXCLUDED.${EPOCH_COLUMN}
    THEN GREATEST("r".${HIGH_WATER_COLUMN}, EXCLUDED.${HIGH_WATER_COLUMN})
    ELSE EXCLUDED.${HIGH_WATER_COLUMN} END,
  ${EPOCH_COLUMN} = EXCLUDED.${EPOCH_COLUMN}`;

const REAP_FAILED = "the PostgreSQL change log could not be reaped";

interface PresentRow {
  present: boolean;
}

interface LockRow {
  took: boolean;
}

let timer: NodeJS.Timeout | undefined;
let isReaping = false;

/**
 * Deletes everything past its retention, under the advisory lock, giving the lock back on every
 * path that took it.
 *
 * The lock is released in a `finally` rather than after the delete because the failing pass is the
 * one that matters: a pass that threw while holding it would leave every other process's reaper
 * doing nothing for the lifetime of this session, and a log that is never reaped again is
 * unbounded growth rather than a missed tick.
 *
 * A missing log is not a failure — a process that has registered no schema has never run the
 * bootstrap, so there is nothing to reap and nothing to report. Checking costs one round trip on a
 * timer measured in minutes.
 */
export async function ReapOnce(
  client: ClientBase,
  retentionMs: number,
): Promise<void> {
  const present = await client.query<PresentRow>(PRESENT, [LOG_REGCLASS]);
  if (!present.rows[0]?.present) {
    return;
  }
  const lock = await client.query<LockRow>(TAKE_LOCK, [REAP_LOCK_KEY]);
  if (!lock.rows[0]?.took) {
    return;
  }
  try {
    await client.query(REAP, [retentionMs]);
  } finally {
    await client.query(RELEASE_LOCK, [REAP_LOCK_KEY]);
  }
}

async function Borrowed(retentionMs: number): Promise<void> {
  const client = await AcquireClient();
  try {
    await ReapOnce(client, retentionMs);
  } finally {
    client.release();
  }
}

/**
 * One tick: never two at once, and never loud — a failed pass is a warning and another tick.
 *
 * The retention is read here, synchronously, rather than inside the pass, so a spec can drive one
 * through a temporary configuration without the set outliving the call (invariant 7).
 */
async function Tick(): Promise<void> {
  if (isReaping) {
    return;
  }
  isReaping = true;
  try {
    await Borrowed(GetOptions().changeRetentionMs);
  } catch (err) {
    Logger.Warn(REAP_FAILED, err);
  } finally {
    isReaping = false;
  }
}

export function ReapInterval(retentionMs: number): number {
  return Math.max(
    SHORTEST_INTERVAL_MS,
    Math.floor(retentionMs / PASSES_PER_WINDOW),
  );
}

/**
 * Starts the reaper, and is idempotent so a reconnect does not leave two timers running.
 *
 * Owned by the connection rather than by a feed, and that is a decision rather than a convenience:
 * a table watched once carries its triggers forever, so the log grows whether or not any feed is
 * still open, and a database whose watchers have all exited would otherwise grow without bound. A
 * process that never opens a feed still reaps, because it may be the only one left connected.
 *
 * The timer is `unref`'d for the same reason the cursor reaper's is — a timer that keeps the event
 * loop alive turns a clean exit into a hang, and the conformance runner exits on its own.
 */
export function StartReaper(): void {
  StopReaper();
  const started = setInterval(() => {
    void Tick();
  }, ReapInterval(GetOptions().changeRetentionMs));
  started.unref();
  timer = started;
}

/** Stops the reaper; registered below so `Disconnect` clears the timer rather than racing it. */
export function StopReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export function IsReaperRunning(): boolean {
  return timer !== undefined;
}

RegisterBeforeDisconnect(StopReaper);
