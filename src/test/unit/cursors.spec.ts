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
  NEXT_TURN_MS,
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

  it("refuses both ends of a forgotten range, its highest id evicted first", async () => {
    const upper = Recorder();
    const lower = Recorder();
    const upperId = NextReqId();
    const lowerId = NextReqId();
    expect(upperId).to.equal(FIRST_SPEC_REQ_ID);
    const openUpper = Reopening(upper, 1, 2);
    const openLower = Reopening(lower, 3, 4);
    expect(await Drain(upperId, openUpper)).to.deep.equal([[1, 2]]);
    expect(await Drain(lowerId, openLower)).to.deep.equal([[3, 4]]);
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

  it("hands over a full batch and then a short one, each in one read, and then ends", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4, 5)]);
    expect(await Drain(NextReqId(), open)).to.deep.equal([
      [1, 2, 3],
      [4, 5],
    ]);
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
    expect(await Drain(NextReqId(), open)).to.deep.equal([[1, 2]]);
    expect(log.statements).to.deep.equal([
      BEGIN,
      DECLARE,
      FETCH,
      CLOSE,
      ROLLBACK,
      RELEASE,
    ]);
  });

  it("answers an empty first batch over a cursor that read no rows", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows()]);
    expect(await Read(NextReqId(), open)).to.deep.equal([]);
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

  it("holds one registration while iterating and releases it on the empty batch", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(await Read(reqId, open)).to.deep.equal([4]);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(CountOpenCursors()).to.equal(baseline);
    expect(log.releases).to.equal(1);
  });

  it("stays exhausted after its empty batch, acquiring nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    expect(await Drain(reqId, open)).to.deep.equal([[1]]);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.acquires).to.equal(1);
    expect(Count(log, BEGIN)).to.equal(1);
    expect(Count(log, DECLARE)).to.equal(1);
    expect(log.releases).to.equal(1);
  });

  it("answers an empty batch after an explicit close, acquiring nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
    await CloseOneCursor(reqId);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.acquires).to.equal(1);
    expect(log.releases).to.equal(1);
    expect(Count(log, FETCH)).to.equal(1);
  });

  it("answers four concurrent reads over a one-batch cursor on one client", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    const answers = await Promise.all([
      Read(reqId, open),
      Read(reqId, open),
      Read(reqId, open),
      Read(reqId, open),
    ]);
    expect(answers).to.deep.equal([[1, 2], [], [], []]);
    expect(log.acquires).to.equal(1);
    expect(log.releases).to.equal(1);
    expect(Count(log, BEGIN)).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("answers an empty batch after the last batch, even once the idle reaper has ended it", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([1, 2]);
    await Delay(REAP_WINDOW_MS);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([]);
    expect(log.releases).to.equal(1);
  });

  it("throws on a read after the idle reaper reclaimed the cursor", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([1, 2, 3]);
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
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
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

  it("answers an empty batch to a read issued just before the close, opening nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    const reading = Read(reqId, open);
    const closing = CloseOneCursor(reqId);
    expect(await reading).to.deep.equal([]);
    await closing;
    expect(log.acquires).to.equal(0);
    expect(log.statements).to.deep.equal([]);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("answers an empty batch to a read whose FETCH is on the wire when the close arrives", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4, 5, 6)]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
    log.holdsNextFetch = true;
    const reading = Read(reqId, open);
    while (!log.resumeFetch) {
      await Delay(NEXT_TURN_MS);
    }
    const closing = CloseOneCursor(reqId);
    log.resumeFetch();
    expect(await reading).to.deep.equal([]);
    await closing;
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

  it("answers an empty batch, acquiring nothing, after a close that preceded every read", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    await CloseOneCursor(reqId);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.acquires).to.equal(0);
    expect(log.statements).to.deep.equal([]);
    expect(CountOpenCursors()).to.equal(baseline);
  });

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
