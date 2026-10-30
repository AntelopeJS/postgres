import type { ClientBase } from "pg";

import { Logger } from "../../logger";
import { GetOptions } from "../../config";
import { CHANGE_LOG_TABLE, REGISTRY_SCHEMA } from "./utils";
import { AcquireClient, RegisterBeforeDisconnect } from "../../connection";
import {
  CREATED_COLUMN,
  EPOCH_COLUMN,
  HIGH_WATER_COLUMN,
  LOG,
  REAPED,
  SEQ_COLUMN,
  SINGLETON_COLUMN,
} from "./changes";

/**
 * The advisory lock every reaping process contends for, a literal so `pg_locks` greps back here.
 * It counts within a session, so a pass takes it once, gives it back once, and never waits.
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
 * A high-water is only comparable within one sequence epoch, and one statement makes the pass atomic.
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

const REAP_FAILED =
  "the PostgreSQL change log could not be reaped and will grow until it can be; every table that was ever watched logs a row per write, and the log is UNLOGGED so only a restart empties it";

const REAP_RECOVERED = "the PostgreSQL change log is being reaped again";

interface PresentRow {
  present: boolean;
}

interface LockRow {
  took: boolean;
}

let timer: NodeJS.Timeout | undefined;
let isReaping = false;
let isFailing = false;

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
 *
 * Answers whether the delete actually ran, which the two early returns make a different question
 * from "did this throw": another process holding the lock is the ordinary case on every deployment
 * of more than one, and reading it as a reap would let it stand in for one that failed.
 */
export async function ReapOnce(
  client: ClientBase,
  retentionMs: number,
): Promise<boolean> {
  const present = await client.query<PresentRow>(PRESENT, [LOG_REGCLASS]);
  if (!present.rows[0]?.present) {
    return false;
  }
  const lock = await client.query<LockRow>(TAKE_LOCK, [REAP_LOCK_KEY]);
  if (!lock.rows[0]?.took) {
    return false;
  }
  try {
    await client.query(REAP, [retentionMs]);
  } finally {
    await client.query(RELEASE_LOCK, [REAP_LOCK_KEY]);
  }
  return true;
}

async function Borrowed(retentionMs: number): Promise<boolean> {
  const client = await AcquireClient();
  try {
    return await ReapOnce(client, retentionMs);
  } finally {
    client.release();
  }
}

/**
 * Whether a failure starts a run of failures, which is the only one reported, since a reaper that
 * cannot reap fails every tick. A pass that cannot run leaves the log growing, so it is an error,
 * not a warning.
 */
function StartsFailureRun(): boolean {
  if (isFailing) {
    return false;
  }
  isFailing = true;
  return true;
}

/** Reports the end of such a run, and only a delete that actually ran ends one. */
function ReportReaped(): void {
  if (!isFailing) {
    return;
  }
  isFailing = false;
  Logger.Info(REAP_RECOVERED);
}

/**
 * One tick: never two at once, and never loud — a failing pass is reported once and tried again.
 * The retention is read here synchronously rather than inside the pass.
 */
async function Tick(): Promise<void> {
  if (isReaping) {
    return;
  }
  isReaping = true;
  try {
    if (await Borrowed(GetOptions().changeRetentionMs)) {
      ReportReaped();
    }
  } catch (err) {
    if (StartsFailureRun()) {
      Logger.Error(REAP_FAILED, err);
    }
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
 *
 * **Both flags reset here, and the re-entrancy one is the load-bearing half.** `pool.end()` abandons
 * an acquisition still queued behind a busy pool rather than rejecting it, so a tick caught inside
 * `AcquireClient` at disconnect never settles and its `finally` never runs. Left set, `isReaping`
 * would turn every later tick into an immediate return — a process that reaps nothing again, for
 * the rest of its life, reporting nothing. Whatever that tick was doing belongs to a pool that no
 * longer exists.
 */
export function StartReaper(): void {
  StopReaper();
  isFailing = false;
  isReaping = false;
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
