import { expect } from "chai";
import type { PoolClient } from "pg";

import type { Options } from "../../config";
import { WithOptions } from "./spec-fixture";
import { SettleBeforeDisconnect } from "../../connection";
import type { ResultRow } from "../../implementations/database/query";
import {
  CloseAllCursors,
  CloseOneCursor,
  CountOpenCursors,
  type CursorOpener,
  ReadCursorRow,
} from "../../implementations/database/cursors";

const CURSOR = '"antelopejs_cursor"';
const SQL = 'SELECT "n" FROM "t" WHERE "n" > ($1::int)';
const PARAMS: unknown[] = [7];

const BATCH_SIZE = 3;
const IDLE_TIMEOUT_MS = 30_000;
const REAPED_AFTER_MS = 1;
const REAP_WINDOW_MS = 40;

/**
 * An idle timeout no other subsystem in this process would ask for.
 *
 * `CapturingTimers` records only the timers armed with exactly this delay, so a `pg-pool` idle
 * timer or anything else the live adapter arms while a spec runs passes through uncounted
 * (these specs share their process with a constructed adapter).
 */
const REAPER_PROBE_MS = 987_654;

const BEGIN = "BEGIN";
const ROLLBACK = "ROLLBACK";
const RELEASE = "RELEASE";
const CLOSE = `CLOSE ${CURSOR}`;
const DECLARE = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${SQL}`;
const FETCH = `FETCH FORWARD ${BATCH_SIZE} FROM ${CURSOR}`;
const FETCH_PREFIX = "FETCH FORWARD";

const PARAM_MARKER = /\$\d/;

const OPTIONS: Options = {
  cursorBatchSize: BATCH_SIZE,
  cursorIdleTimeoutMs: IDLE_TIMEOUT_MS,
};

const REAPING: Options = {
  cursorBatchSize: BATCH_SIZE,
  cursorIdleTimeoutMs: REAPED_AFTER_MS,
};

const PROBING: Options = {
  cursorBatchSize: BATCH_SIZE,
  cursorIdleTimeoutMs: REAPER_PROBE_MS,
};

const NO_VALUES: unknown[] = [];
const STUB_FAILURE = "the stub client refused this statement";
const NEVER_ENDED = "the cursor never answered done";
const NEVER_REJECTED = "the read was expected to reject";
const NEVER_ARRIVED = "no read arrived while the sweep was running";
const NEVER_HELD = "the stub never reached the statement it was told to hold";
const DOUBLE_RELEASE = "this client was already handed back to the pool";
const DRAIN_LIMIT = 50;

/** How many event-loop turns a spec gives a promise that must *not* settle before it concludes it will not. */
const SETTLE_TURNS = 8;

/** A recorded moment that never happened; the specs assert the real value replaced it. */
const NOT_OBSERVED = -1;

const FORGOTTEN_HINT = "no longer remembered";
const DESCENDING_CURSORS = 4;

const DECLARE_POSITION = 1;
const STALE_TIMER = 0;
const LAST_TIMER = 1;
const NEXT_TURN_MS = 0;
const IDLE_TIMEOUT_OPTION = "cursorIdleTimeoutMs";

/** The module forgets an ending once this many others have been recorded after it. */
const REMEMBERED_ENDINGS = 1024;

/**
 * The interface's `nextReqId` is a process-global counter that starts at 0 and shares this process
 * with the specs, so the specs count down instead — the counter can never reach a negative id.
 */
const FIRST_SPEC_REQ_ID = -1;

interface Recording {
  statements: string[];
  bound: unknown[][];
  releases: number;
  acquires: number;
  whenReleased?: () => void;
  holdsNextFetch?: boolean;
  resumeFetch?: () => void;
  holdsStatement?: string;
  resumeHeld?: () => void;
}

function Recorder(): Recording {
  return { statements: [], bound: [], releases: 0, acquires: 0 };
}

/**
 * A `PoolClient` that answers `FETCH` from a queue of batches and records everything else.
 *
 * The batches are the only script it needs: every other statement a cursor issues answers no rows,
 * and `failing` is the one whose text it refuses, which is how the open and fetch failure paths are
 * driven without a server.
 *
 * `release` writes into the *same* ordered log as the statements, because the ordering between them
 * is the property that matters: a client handed back before its `ROLLBACK` fails the next unrelated
 * query with `25P02`, and a stub that only counted releases could not see the difference.
 *
 * `holdsStatement` parks one named statement on the wire until the spec resolves it, which is the
 * only way to observe a teardown *while it is running*: the window between the state being marked
 * ended and its `release()` returning is two round trips wide, and every question about a client
 * still being checked out lives inside it.
 */
function StubClient(
  log: Recording,
  batches: ResultRow[][],
  failing?: string,
): PoolClient {
  let isReleased = false;
  const stub = {
    query: (sql: string, values?: unknown[]) => {
      log.statements.push(sql);
      log.bound.push(values ?? NO_VALUES);
      if (sql === failing) {
        return Promise.reject(new Error(STUB_FAILURE));
      }
      if (sql === log.holdsStatement) {
        log.holdsStatement = undefined;
        return new Promise((resolve) => {
          log.resumeHeld = () => resolve({ rows: [] });
        });
      }
      if (!sql.startsWith(FETCH_PREFIX)) {
        return Promise.resolve({ rows: [] });
      }
      const rows = batches.shift() ?? [];
      if (!log.holdsNextFetch) {
        return Promise.resolve({ rows });
      }
      log.holdsNextFetch = false;
      return new Promise((resolve) => {
        log.resumeFetch = () => resolve({ rows });
      });
    },
    release: () => {
      log.statements.push(RELEASE);
      log.bound.push(NO_VALUES);
      log.releases += 1;
      if (isReleased) {
        throw new Error(DOUBLE_RELEASE);
      }
      isReleased = true;
      log.whenReleased?.();
    },
  };
  return stub as unknown as PoolClient;
}

function Decode(rows: ResultRow[]): unknown[] {
  return rows.map((row) => row.n);
}

function Requesting(
  log: Recording,
  batches: ResultRow[][],
  failing?: string,
): CursorOpener {
  return () =>
    Promise.resolve({
      sql: SQL,
      params: PARAMS,
      decode: Decode,
      acquire: () => {
        log.acquires += 1;
        return Promise.resolve(StubClient(log, batches, failing));
      },
    });
}

function Rows(...values: number[]): ResultRow[] {
  return values.map((n) => ({ n }));
}

/**
 * An opener whose every open answers the same rows from the top, which is what production does.
 *
 * `Requesting` hands one mutable batch queue to every client it makes, so a cursor that re-opened
 * would silently read an empty queue and look correct. Re-running the query from the top is what
 * makes a re-open visible as row 1 served a second time.
 */
function Reopening(log: Recording, ...values: number[]): CursorOpener {
  return () =>
    Promise.resolve({
      sql: SQL,
      params: PARAMS,
      decode: Decode,
      acquire: () => {
        log.acquires += 1;
        return Promise.resolve(StubClient(log, [Rows(...values)]));
      },
    });
}

let lastReqId = FIRST_SPEC_REQ_ID + 1;
let claimed: number[] = [];

function NextReqId(): number {
  lastReqId -= 1;
  claimed.push(lastReqId);
  return lastReqId;
}

/** One read, through a temporary configuration set and restored inside this one turn. */
function Read(reqId: number, open: CursorOpener, options: Options = OPTIONS) {
  return WithOptions(options, () => ReadCursorRow(reqId, open));
}

async function Drain(reqId: number, open: CursorOpener): Promise<unknown[]> {
  const values: unknown[] = [];
  while (values.length < DRAIN_LIMIT) {
    const next = await Read(reqId, open);
    if (next.done) {
      return values;
    }
    values.push(next.value);
  }
  throw new Error(NEVER_ENDED);
}

async function Rejection(read: Promise<unknown>): Promise<Error> {
  try {
    await read;
  } catch (err) {
    return err as Error;
  }
  throw new Error(NEVER_REJECTED);
}

function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Gives every pending continuation room to run, so "has not settled" means it never will. */
async function Settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await Delay(NEXT_TURN_MS);
  }
}

/** Waits until the stub has parked `holdsStatement` on the wire, so the teardown is measurably mid-flight. */
async function WhenHeld(log: Recording): Promise<() => void> {
  for (let turn = 0; turn < DRAIN_LIMIT; turn += 1) {
    if (log.resumeHeld) {
      return log.resumeHeld;
    }
    await Delay(NEXT_TURN_MS);
  }
  throw new Error(NEVER_HELD);
}

/** Fills the endings map past its bound, which forgets everything that ended before this call. */
async function OverflowEndings(): Promise<void> {
  const filler = Recorder();
  for (let index = 0; index < REMEMBERED_ENDINGS; index += 1) {
    await Read(NextReqId(), Requesting(filler, [Rows()]));
  }
}

interface TimerLog {
  armed: NodeJS.Timeout[];
  handlers: (() => void)[];
  cleared: NodeJS.Timeout[];
}

function TimerRecorder(): TimerLog {
  return { armed: [], handlers: [], cleared: [] };
}

/**
 * Runs `body` with pass-through timer functions that collect the reaper's timers and handlers.
 *
 * Both wrappers forward to the real ones and return what they returned, so nothing observable
 * changes for anything else sharing the process, and only timers armed with `delayMs` are recorded
 * — the patch spans an `await`, and the live adapter this process also runs arms timers of its own.
 * Capturing the handler is what lets a spec fire a stale reaper on demand, which is the race the
 * timer's identity re-check exists for and which no wall-clock spec can schedule.
 */
async function CapturingTimers(
  log: TimerLog,
  delayMs: number,
  body: () => Promise<void>,
): Promise<void> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: never, ms: never, ...rest: never[]) => {
    const timer = realSet(handler, ms, ...rest);
    if (ms === (delayMs as never)) {
      log.armed.push(timer);
      log.handlers.push(handler);
    }
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
    if (log.armed.includes(timer)) {
      log.cleared.push(timer);
    }
    realClear(timer);
  }) as typeof clearTimeout;
  try {
    await body();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

function Count(log: Recording, statement: string): number {
  return log.statements.filter((sql) => sql === statement).length;
}

describe("the cursor registry", () => {
  let baseline = 0;

  beforeEach(() => {
    baseline = CountOpenCursors();
    claimed = [];
  });

  /**
   * A spec leaves nothing of its own checked out, and the sweep specs leave *less* than they found.
   *
   * `CloseAllCursors` is global, so a spec that drives it also reclaims whatever the live adapter
   * this process shares had open when the spec started. The check is therefore a
   * ceiling on the count rather than an equality with the baseline, which would read another
   * subsystem's reclaimed cursor as this file's leak.
   */
  afterEach(async () => {
    const held = CountOpenCursors();
    await Promise.all(claimed.map((reqId) => CloseOneCursor(reqId)));
    expect(held).to.be.at.most(baseline);
  });

  /**
   * The top of the forgotten range is fixed by the first eviction the process ever makes.
   *
   * `Evicted` widens the range with `Math.max`, so the highest `reqId` it will ever carry is the
   * highest one it ever drops — and every id this file allocates is lower than the last. Only the
   * spec that owns the first two endings can therefore name the range's **upper** endpoint, which
   * is why this one runs first and asserts the id it was handed. A spec inserted above it takes
   * that endpoint out of reach, and the equality below says so rather than passing on quietly.
   *
   * The two endings are then evicted highest-first, so the range's top is the id evicted *earliest*
   * and its bottom the id evicted last. That order is what makes the widening observable at all: a
   * range that merely tracked the most recent eviction would answer this exact pair with a top
   * below its own bottom, and the highest id — refused here — would re-open and serve its first row
   * a second time.
   */
  it("refuses both ends of a forgotten range, its highest id evicted first", async () => {
    const upper = Recorder();
    const lower = Recorder();
    const upperId = NextReqId();
    const lowerId = NextReqId();
    expect(upperId).to.equal(FIRST_SPEC_REQ_ID);
    const openUpper = Reopening(upper, 1, 2);
    const openLower = Reopening(lower, 3, 4);
    expect(await Drain(upperId, openUpper)).to.deep.equal([1, 2]);
    expect(await Drain(lowerId, openLower)).to.deep.equal([3, 4]);
    await OverflowEndings();
    const refusedUpper = await Rejection(Read(upperId, openUpper));
    const refusedLower = await Rejection(Read(lowerId, openLower));
    expect(refusedUpper.message).to.contain(`${upperId}`);
    expect(refusedUpper.message).to.contain(FORGOTTEN_HINT);
    expect(refusedLower.message).to.contain(`${lowerId}`);
    expect(refusedLower.message).to.contain(FORGOTTEN_HINT);
    expect([upper.acquires, lower.acquires]).to.deep.equal([1, 1]);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("yields a full batch and then a short one, in order, and then ends", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4, 5)]);
    expect(await Drain(NextReqId(), open)).to.deep.equal([1, 2, 3, 4, 5]);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
    expect(log.releases).to.equal(1);
  });

  it("ends after a short first batch without fetching a second time", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2)]);
    expect(await Drain(NextReqId(), open)).to.deep.equal([1, 2]);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
  });

  it("ends immediately over a cursor that read no rows", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows()]);
    const next = await Read(NextReqId(), open);
    expect(next.done).to.equal(true);
    expect(next.value).to.equal(undefined);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
    expect(log.releases).to.equal(1);
  });

  it("rolls back after closing the cursor and before handing the client back", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1)]);
    await Drain(NextReqId(), open);
    const closed = log.statements.indexOf(CLOSE);
    const rolled = log.statements.indexOf(ROLLBACK);
    const released = log.statements.indexOf(RELEASE);
    expect(closed).to.be.lessThan(rolled);
    expect(rolled).to.be.lessThan(released);
  });

  it("holds one registration while iterating and none once exhausted", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    await Read(reqId, open);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    await Read(reqId, open);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect((await Read(reqId, open)).done).to.equal(true);
    expect(CountOpenCursors()).to.equal(baseline);
    expect(log.releases).to.equal(1);
  });

  it("stays done after exhaustion, acquiring nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    expect(await Drain(reqId, open)).to.deep.equal([1]);
    const after = await Read(reqId, open);
    expect(after.done).to.equal(true);
    expect(after.value).to.equal(undefined);
    expect(log.acquires).to.equal(1);
    expect(Count(log, BEGIN)).to.equal(1);
    expect(Count(log, DECLARE)).to.equal(1);
    expect(log.releases).to.equal(1);
  });

  it("stays done after an explicit close, acquiring nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect((await Read(reqId, open)).value).to.equal(1);
    await CloseOneCursor(reqId);
    const after = await Read(reqId, open);
    expect(after.done).to.equal(true);
    expect(log.acquires).to.equal(1);
    expect(log.releases).to.equal(1);
    expect(Count(log, FETCH)).to.equal(1);
  });

  it("answers four concurrent reads over a two-row cursor on one client", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    const answers = await Promise.all([
      Read(reqId, open),
      Read(reqId, open),
      Read(reqId, open),
      Read(reqId, open),
    ]);
    expect(answers.map((answer) => answer.value)).to.deep.equal([
      1,
      2,
      undefined,
      undefined,
    ]);
    expect(answers.map((answer) => answer.done)).to.deep.equal([
      false,
      false,
      true,
      true,
    ]);
    expect(log.acquires).to.equal(1);
    expect(log.releases).to.equal(1);
    expect(Count(log, BEGIN)).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("throws on a read after the idle reaper reclaimed the cursor", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect((await Read(reqId, open, REAPING)).value).to.equal(1);
    await Delay(REAP_WINDOW_MS);
    await CloseOneCursor(reqId);
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(IDLE_TIMEOUT_OPTION);
    expect(err.message).to.contain(`${REAPED_AFTER_MS} ms`);
    expect(err.message).to.contain(`${reqId}`);
    expect(log.acquires).to.equal(1);
    expect(log.releases).to.equal(1);
  });

  it("releases exactly once when closed part-way through", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect((await Read(reqId, open)).value).to.equal(1);
    await CloseOneCursor(reqId);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("closes behind a read that is still in flight, and answers it first", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    const reading = Read(reqId, open);
    const closing = CloseOneCursor(reqId);
    const first = await reading;
    await closing;
    expect(first.value).to.equal(1);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("does nothing on a second close, and nothing on a close after exhaustion", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    await Drain(reqId, open);
    await CloseOneCursor(reqId);
    await CloseOneCursor(reqId);
    expect(Count(log, CLOSE)).to.equal(1);
    expect(Count(log, ROLLBACK)).to.equal(1);
    expect(log.releases).to.equal(1);
  });

  it("acquires nothing on a close for a reqId that never opened", async () => {
    await CloseOneCursor(NextReqId());
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * A close arriving before the first read ends the cursor rather than leaving it openable.
   *
   * `IterableCursor` calls `CloseCursor` unconditionally on `return()`, so a cursor that is
   * constructed and closed without ever being iterated reaches this module on a `reqId` it has
   * never seen — and a close that registered nothing would leave that id looking new. The next
   * read then takes the *open* path: a client acquired, the query declared and row 0 served to a
   * consumer that has already closed the iterator. Nothing orders a first read against a close, so
   * this is a remembered ending one step earlier rather than a second problem.
   */
  it("answers done, acquiring nothing, after a close that preceded every read", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    await CloseOneCursor(reqId);
    const after = await Read(reqId, open);
    expect(after.done).to.equal(true);
    expect(after.value).to.equal(undefined);
    expect(log.acquires).to.equal(0);
    expect(log.statements).to.deep.equal([]);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * The ending a close-before-open records is an ending like any other, and is forgotten like one.
   *
   * Registering a `reqId` without retiring it through the same path would leave one entry resident
   * for the life of the process per cursor closed unread, and the refusal below is what tells the
   * two apart: an entry that never joined the endings queue would still be there afterwards,
   * answering `done` where a genuinely forgotten `reqId` is refused.
   */
  it("forgets a close that preceded every read, like any other ending", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    await CloseOneCursor(reqId);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.acquires).to.equal(0);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("rolls back and releases when the DECLARE is refused, registering nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [], DECLARE);
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.equal(STUB_FAILURE);
    expect(log.statements).to.deep.equal([BEGIN, DECLARE, ROLLBACK, RELEASE]);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
    expect((await Read(reqId, open)).done).to.equal(true);
    expect(log.acquires).to.equal(1);
  });

  it("releases without rolling back when the BEGIN itself is refused", async () => {
    const log = Recorder();
    const open = Requesting(log, [], BEGIN);
    await Rejection(Read(NextReqId(), open));
    expect(log.statements).to.deep.equal([BEGIN, RELEASE]);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("acquires nothing when the statement never compiled", async () => {
    const log = Recorder();
    const refused = new Error("this stage array compiles no relation");
    const err = await Rejection(
      Read(NextReqId(), () => Promise.reject(refused)),
    );
    expect(err).to.equal(refused);
    expect(log.statements).to.deep.equal([]);
    expect(log.acquires).to.equal(0);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("rolls back and releases when a FETCH is refused", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2, 3)], FETCH);
    await Rejection(Read(NextReqId(), open));
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("answers two concurrent reads consecutive rows, over one open and one fetch", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3)]);
    const [first, second] = await Promise.all([
      Read(reqId, open),
      Read(reqId, open),
    ]);
    expect([first.value, second.value]).to.deep.equal([1, 2]);
    expect(log.statements).to.deep.equal([BEGIN, DECLARE, FETCH]);
    expect(log.acquires).to.equal(1);
    await CloseOneCursor(reqId);
    expect(log.releases).to.equal(1);
  });

  it("arms an unreferenced reaper on every read", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    const timers = TimerRecorder();
    await CapturingTimers(timers, REAPER_PROBE_MS, async () => {
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
    });
    expect(timers.armed).to.have.length(3);
    expect(timers.armed.map((timer) => timer.hasRef())).to.deep.equal([
      false,
      false,
      false,
    ]);
    await CloseOneCursor(reqId);
  });

  it("clears the reaper it armed on the previous read, and the last one on close", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    const timers = TimerRecorder();
    await CapturingTimers(timers, REAPER_PROBE_MS, async () => {
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
      expect(timers.cleared).to.deep.equal([timers.armed[0], timers.armed[1]]);
      await CloseOneCursor(reqId);
    });
    expect(timers.cleared).to.deep.equal(timers.armed);
  });

  it("ignores a reaper timer that fired before a read re-armed it", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3)]);
    const timers = TimerRecorder();
    await CapturingTimers(timers, REAPER_PROBE_MS, async () => {
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
    });
    timers.handlers[STALE_TIMER]();
    await Delay(REAP_WINDOW_MS);
    expect(log.statements).to.deep.equal([BEGIN, DECLARE, FETCH]);
    expect(log.releases).to.equal(0);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    await CloseOneCursor(reqId);
  });

  it("keeps a reaper that fires mid-read from cutting into the read", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4, 5, 6)]);
    const timers = TimerRecorder();
    await CapturingTimers(timers, REAPER_PROBE_MS, async () => {
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
      await Read(reqId, open, PROBING);
      log.holdsNextFetch = true;
      const held = Read(reqId, open, PROBING);
      while (!log.resumeFetch) {
        await Delay(NEXT_TURN_MS);
      }
      timers.handlers[timers.handlers.length - LAST_TIMER]();
      log.resumeFetch();
      expect((await held).value).to.equal(4);
    });
    expect(log.statements).to.deep.equal([BEGIN, DECLARE, FETCH, FETCH]);
    expect(log.releases).to.equal(0);
    await CloseOneCursor(reqId);
  });

  it("reclaims a cursor left idle past its timeout, through the same teardown", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect((await Read(reqId, open, REAPING)).value).to.equal(1);
    await Delay(REAP_WINDOW_MS);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("fetches a literal count and binds no parameter to it", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3)]);
    await Read(reqId, open);
    await CloseOneCursor(reqId);
    const fetched = log.statements.indexOf(FETCH);
    expect(log.statements[fetched]).to.equal(
      `FETCH FORWARD 3 FROM "antelopejs_cursor"`,
    );
    expect(log.statements[fetched]).to.not.match(PARAM_MARKER);
    expect(log.bound[fetched]).to.deep.equal([]);
  });

  it("binds the rendered statement's parameters on the DECLARE", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    await Read(reqId, open);
    await CloseOneCursor(reqId);
    expect(log.statements[DECLARE_POSITION]).to.equal(DECLARE);
    expect(log.statements[DECLARE_POSITION]).to.match(PARAM_MARKER);
    expect(log.bound[DECLARE_POSITION]).to.deep.equal(PARAMS);
  });

  /**
   * The one place this file asks the absolute question, because the sweep is the one global answer.
   *
   * Every other count is read against the baseline the spec started from — these specs share their
   * process with a live adapter, and a cursor this file never opened is not its leak.
   * `CloseAllCursors` is the exception by contract: it is what runs before `pool.end()`, which was
   * measured not to resolve while **any** client is checked out, so "none of ours" would be the
   * wrong claim to make about it.
   */
  it("closes every open cursor, and empties the registry", async () => {
    const first = Recorder();
    const second = Recorder();
    await Read(NextReqId(), Requesting(first, [Rows(1, 2, 3)]));
    await Read(NextReqId(), Requesting(second, [Rows(4, 5, 6)]));
    expect(CountOpenCursors()).to.equal(baseline + 2);
    await CloseAllCursors();
    expect(CountOpenCursors()).to.equal(0);
    expect([first.releases, second.releases]).to.deep.equal([1, 1]);
    expect([Count(first, ROLLBACK), Count(second, ROLLBACK)]).to.deep.equal([
      1, 1,
    ]);
  });

  it("opens nothing for a read that arrives while the sweep is running", async () => {
    const held = Recorder();
    const arriving = Recorder();
    const heldId = NextReqId();
    const arrivingId = NextReqId();
    const openArriving = Requesting(arriving, [Rows(7, 8, 9)]);
    let late: Promise<IteratorResult<unknown, void>> | undefined;
    let isAnswered = false;
    held.whenReleased = () => {
      late =
        late ??
        Read(arrivingId, openArriving).then((answer) => {
          isAnswered = true;
          return answer;
        });
    };
    const openHeld = Requesting(held, [Rows(1, 2, 3), Rows(4, 5, 6)]);
    expect((await Read(heldId, openHeld)).value).to.equal(1);
    await CloseAllCursors();
    if (!late) {
      throw new Error(NEVER_ARRIVED);
    }
    expect(isAnswered).to.equal(true);
    expect((await late).done).to.equal(true);
    expect(arriving.acquires).to.equal(0);
    expect(arriving.statements).to.deep.equal([]);
    expect(held.acquires).to.equal(1);
    expect(held.releases).to.equal(1);
  });

  it("counts a cursor whose teardown is still on the wire as checked out", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    expect((await Read(reqId, open)).value).to.equal(1);
    log.holdsStatement = CLOSE;
    const ending = Read(reqId, open);
    const resume = await WhenHeld(log);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(log.releases).to.equal(0);
    resume();
    expect((await ending).done).to.equal(true);
    expect(log.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("does not resolve the sweep while a self-reclaim is still on the wire", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    expect((await Read(reqId, open)).value).to.equal(1);
    log.holdsStatement = CLOSE;
    const ending = Read(reqId, open);
    const resume = await WhenHeld(log);
    let isSwept = false;
    const sweeping = CloseAllCursors().then(() => {
      isSwept = true;
    });
    await Settle();
    expect(isSwept).to.equal(false);
    expect(log.releases).to.equal(0);
    resume();
    await sweeping;
    expect(log.releases).to.equal(1);
    expect((await ending).done).to.equal(true);
  });

  it("does not resolve the sweep while an explicit close is still on the wire", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect((await Read(reqId, open)).value).to.equal(1);
    log.holdsStatement = CLOSE;
    const closing = CloseOneCursor(reqId);
    const resume = await WhenHeld(log);
    let isSwept = false;
    const sweeping = CloseAllCursors().then(() => {
      isSwept = true;
    });
    await Settle();
    expect(isSwept).to.equal(false);
    expect(log.releases).to.equal(0);
    resume();
    await Promise.all([closing, sweeping]);
    expect(log.releases).to.equal(1);
  });

  it("does not resolve the sweep while a reaper teardown is still on the wire", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    log.holdsStatement = CLOSE;
    expect((await Read(reqId, open, REAPING)).value).to.equal(1);
    const resume = await WhenHeld(log);
    let isSwept = false;
    const sweeping = CloseAllCursors().then(() => {
      isSwept = true;
    });
    await Settle();
    expect(isSwept).to.equal(false);
    expect(log.releases).to.equal(0);
    resume();
    await sweeping;
    expect(log.releases).to.equal(1);
  });

  /**
   * `SettleBeforeDisconnect` is handed a probe in place of `EndPool`, so no pool is ever ended.
   *
   * That substitution is the whole reason this spec can exist here: the real teardown would take
   * the adapter this process shares with the conformance suites down with it, while
   * the probe runs at exactly the instant `pool.end()` would and reads what it would have found.
   *
   * What it reads is absolute, and deliberately so. `pool.end()` was measured not to resolve while
   * **any** client is checked out, so the property the before-disconnect wire has to deliver is
   * that nothing at all is still out — not merely nothing this spec opened.
   */
  it("hands every client back before the pool is ended", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    expect((await Read(reqId, open)).value).to.equal(1);
    log.holdsStatement = CLOSE;
    const ending = Read(reqId, open);
    const resume = await WhenHeld(log);
    let checkedOutAtEnd = NOT_OBSERVED;
    let releasesAtEnd = NOT_OBSERVED;
    const disconnecting = SettleBeforeDisconnect(() => {
      checkedOutAtEnd = CountOpenCursors();
      releasesAtEnd = log.releases;
      return Promise.resolve();
    });
    await Settle();
    expect(checkedOutAtEnd).to.equal(NOT_OBSERVED);
    resume();
    await disconnecting;
    expect(checkedOutAtEnd).to.equal(0);
    expect(releasesAtEnd).to.equal(1);
    expect((await ending).done).to.equal(true);
  });

  it("opens a run of descending ids after an eviction, refusing none of them", async () => {
    await OverflowEndings();
    for (let index = 0; index < DESCENDING_CURSORS; index += 1) {
      const log = Recorder();
      const rows = await Drain(NextReqId(), Requesting(log, [Rows(1, 2)]));
      expect(rows).to.deep.equal([1, 2]);
      expect(log.acquires).to.equal(1);
      expect(Count(log, BEGIN)).to.equal(1);
    }
  });

  it("refuses a reqId whose exhaustion it has forgotten, rather than re-opening it", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    expect(await Drain(reqId, open)).to.deep.equal([1, 2]);
    expect((await Read(reqId, open)).done).to.equal(true);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.acquires).to.equal(1);
    expect(Count(log, BEGIN)).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("refuses a reqId whose reaping it has forgotten, rather than re-serving its rows", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    expect((await Read(reqId, open, REAPING)).value).to.equal(1);
    await Delay(REAP_WINDOW_MS);
    expect(log.releases).to.equal(1);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.acquires).to.equal(1);
    expect(Count(log, BEGIN)).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * The forgotten range answers for a `reqId` the registry no longer holds, and for no other.
   *
   * A cursor is allocated its id when it is *constructed* and iterated whenever its consumer gets
   * round to it, so a slow one's id sits inside a range that grew around it while it was reading —
   * evictions above it from before it started, evictions below it from every cursor built since.
   * It is still live, still holding its client, and the registry still has it, so the range is not
   * the question being asked about it.
   *
   * Consulting the range first instead would end a cursor mid-iteration, one row into a result the
   * caller is still reading, and hand it the refusal a genuinely forgotten `reqId` earns — while
   * its client stays checked out with nothing left able to give it back.
   */
  it("keeps serving a live cursor the forgotten range has grown around", async () => {
    const live = Recorder();
    const ended = Recorder();
    const liveId = NextReqId();
    const endedId = NextReqId();
    const openLive = Reopening(live, 1, 2);
    expect((await Read(liveId, openLive)).value).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(await Drain(endedId, Reopening(ended, 3, 4))).to.deep.equal([3, 4]);
    await OverflowEndings();
    expect((await Read(liveId, openLive)).value).to.equal(2);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(live.acquires).to.equal(1);
    expect(Count(live, BEGIN)).to.equal(1);
    await CloseOneCursor(liveId);
    expect(live.releases).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * An open that failed ends its `reqId` without ever having held a client, and is forgotten like
   * any other ending.
   *
   * Nothing else can forget it. A state that ends while holding a client is recorded when its
   * `release()` returns, but a failed open has nothing to give back and reaches that point already
   * empty-handed — so if the ending is not recorded where it happens, the state stays resident for
   * the life of the process. Every failed open, every read of a forgotten `reqId` and every read
   * that raced the sweep would leave one behind, and each would go on answering `done` over a query
   * that never ran where a forgotten cursor is refused.
   */
  it("refuses a reqId whose failed open it has forgotten, rather than answering done", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [], DECLARE);
    expect((await Rejection(Read(reqId, open))).message).to.equal(STUB_FAILURE);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.acquires).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });
});
