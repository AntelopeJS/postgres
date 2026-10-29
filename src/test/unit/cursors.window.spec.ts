import { expect } from "chai";
import {
  CloseOneCursor,
  CountOpenCursors,
} from "../../implementations/database/cursors";
import {
  baseline,
  BEGIN,
  Count,
  DECLARE,
  Delay,
  DESCENDING_CURSORS,
  Drain,
  FORGOTTEN_HINT,
  GuardTheRegistry,
  NextReqId,
  OverflowEndings,
  Read,
  REAP_WINDOW_MS,
  REAPING,
  Recorder,
  Rejection,
  Reopening,
  Requesting,
  Rows,
  STUB_FAILURE,
} from "./cursors-fixture";

describe("the cursor registry", () => {
  GuardTheRegistry();

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
