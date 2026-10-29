import { expect } from "chai";
import { SettleBeforeDisconnect } from "../../connection";
import {
  CloseAllCursors,
  CloseOneCursor,
  CountOpenCursors,
} from "../../implementations/database/cursors";
import {
  baseline,
  BEGIN,
  CapturingTimers,
  CLOSE,
  Count,
  DECLARE,
  DECLARE_POSITION,
  Delay,
  FETCH,
  GuardTheRegistry,
  LAST_TIMER,
  NEVER_ARRIVED,
  NEXT_TURN_MS,
  NextReqId,
  NOT_OBSERVED,
  PARAM_MARKER,
  PARAMS,
  PROBING,
  Read,
  REAP_WINDOW_MS,
  REAPER_PROBE_MS,
  REAPING,
  Recorder,
  Rejection,
  RELEASE,
  Requesting,
  ROLLBACK,
  Rows,
  Settle,
  STALE_TIMER,
  STUB_FAILURE,
  TimerRecorder,
  WhenHeld,
} from "./cursors-fixture";

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});

describe("the cursor registry", () => {
  GuardTheRegistry();

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
});
