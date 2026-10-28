import { expect } from "chai";
import {
  CloseOneCursor,
  CountOpenCursors,
} from "../../implementations/database/cursors";
import {
  baseline,
  BEGIN,
  CLOSE,
  Count,
  DECLARE,
  Delay,
  Drain,
  FETCH,
  FIRST_SPEC_REQ_ID,
  FORGOTTEN_HINT,
  GuardTheRegistry,
  IDLE_TIMEOUT_OPTION,
  NextReqId,
  OverflowEndings,
  Read,
  REAP_WINDOW_MS,
  REAPED_AFTER_MS,
  REAPING,
  Recorder,
  Rejection,
  RELEASE,
  Reopening,
  Requesting,
  ROLLBACK,
  Rows,
} from "./cursors-fixture";

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});
