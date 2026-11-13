import assert from "node:assert";
import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { WhileConfigured } from "./spec-fixture";
import { CloseCursor, ReadCursor } from "../../implementations/database/query";
import {
  CloseAllFeeds,
  CloseOneFeed,
  IsRegisteredFeed,
} from "../../implementations/database/feeds";
import {
  EPOCH,
  Feed,
  NewReqId,
  Reader,
  SCHEMA_ID,
  Stages,
  Step,
  TABLE_ID,
} from "./feeds-fixture";

const SETTLE_MS = 60;
const LATER_EPOCH = new Date("2026-08-12T10:00:00.000Z");

/** One side of an event as the laterals answer it: what it projected, and whether it matched. */
function Side<Doc>(doc: Doc, matched = true) {
  return { doc, matched };
}

const ABSENT = Side(null, false);

describe("a change feed's refusals", () => {
  it("refuses a stage that needs an order, naming the stage and the position", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, QueryStage("orderBy", { index: "at" })).then(
        () => expect.fail("a feed has no total order to sort by"),
        (err: unknown) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("'orderBy'");
          expect(err.message).to.contain("'changes'");
        },
      );
    });
  });

  it("refuses a stage that needs a finite relation, for the reason it names", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, QueryStage("count", {})).then(
        () => expect.fail("a feed is not finite"),
        (err: unknown) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("'count'");
          expect(err.message).to.contain("total order or a finite relation");
        },
      );
    });
  });

  it("refuses a terminal write before a feed, which is legal one level out", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, QueryStage("insert", undefined, {})).then(
        () => expect.fail("a feed writes nothing"),
        (err: unknown) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("'insert'");
          expect(err.message).to.contain("'changes'");
        },
      );
    });
  });

  it("names the first unsupported stage rather than the last", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(
        reqId,
        read,
        QueryStage("orderBy", { index: "at" }),
        QueryStage("slice", undefined, 0),
      ).then(
        () => expect.fail("neither stage is supported"),
        (err: unknown) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("'orderBy'");
          expect(err.message).to.not.contain("'slice'");
        },
      );
    });
  });
});

describe("a change feed's watermark", () => {
  it("opens above everything already settled, so it delivers only what happens next", async () => {
    const { read, asked } = Reader([
      { scanned_to: "42" },
      { scanned_to: null, events: [] },
    ]);
    await Feed(async (reqId) => {
      await Promise.race([
        Step(reqId, read),
        new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
      ]);
      expect(asked[0].sql).to.contain("GREATEST");
      expect(asked[1].params).to.deep.equal([
        SCHEMA_ID,
        TABLE_ID,
        "default",
        "42",
      ]);
    });
  });

  it("opens above the reaper's high-water too, which an emptied log does not carry", async () => {
    const { read, asked } = Reader([{ scanned_to: "0" }]);
    await Feed(async (reqId) => {
      await Promise.race([
        Step(reqId, read),
        new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
      ]);
      expect(asked[0].sql).to.contain(`FROM "__antelope"."changes_reaped"`);
    });
  });

  it("consumes only transactions that have settled", async () => {
    const { read, asked } = Reader([{ scanned_to: "1" }, { events: [] }]);
    await Feed(async (reqId) => {
      await Promise.race([
        Step(reqId, read),
        new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
      ]);
      for (const statement of asked) {
        expect(statement.sql).to.contain(
          "pg_snapshot_xmin(pg_current_snapshot())",
        );
      }
    });
  });

  it("advances over the rows it scanned rather than the ones it delivered", async () => {
    const { read, asked } = Reader([
      { scanned_to: "10" },
      {
        scanned_to: "17",
        events: [{ op: "added", old: ABSENT, new: Side({ _id: "a" }) }],
      },
      { scanned_to: null, events: [] },
    ]);
    await Feed(async (reqId) => {
      await Step(reqId, read);
      await Promise.race([
        Step(reqId, read),
        new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
      ]);
      expect(asked[2].params[3]).to.equal("17");
    });
  });

  it("scopes the read to the instance the query named", async () => {
    const { read, asked } = Reader([{ scanned_to: "0" }, { events: [] }]);
    await Feed(async (reqId) => {
      await Promise.race([
        Step(reqId, read),
        new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
      ]);
      expect(asked[1].sql).to.contain(`"instance" = $3`);
      expect(asked[1].params).to.have.lengthOf(4);
    });
  });
});

describe("a change feed's events", () => {
  it("delivers an insert as an added event carrying only the new value", async () => {
    const { read } = Reader([
      { scanned_to: "0" },
      {
        scanned_to: "1",
        events: [
          { op: "added", old: ABSENT, new: Side({ _id: "a", car: "Renault" }) },
        ],
      },
    ]);
    await Feed(async (reqId) => {
      const step = await Step(reqId, read);
      expect(step.value).to.have.property("changeType", "added");
      expect(step.value).to.not.have.property("oldValue");
      expect(step.value).to.have.deep.property("newValue", {
        _id: "a",
        car: "Renault",
      });
    });
  });

  it("delivers a delete as a removed event carrying only the old value", async () => {
    const { read } = Reader([
      { scanned_to: "0" },
      {
        scanned_to: "1",
        events: [{ op: "removed", old: Side({ _id: "a" }), new: ABSENT }],
      },
    ]);
    await Feed(async (reqId) => {
      const step = await Step(reqId, read);
      expect(step.value).to.have.property("changeType", "removed");
      expect(step.value).to.not.have.property("newValue");
      expect(step.value).to.have.deep.property("oldValue", { _id: "a" });
    });
  });

  it("delivers an update as a modified event carrying both sides", async () => {
    const { read } = Reader([
      { scanned_to: "0" },
      {
        scanned_to: "1",
        events: [
          {
            op: "modified",
            old: Side({ _id: "a", price: 1 }),
            new: Side({ _id: "a", price: 2 }),
          },
        ],
      },
    ]);
    await Feed(async (reqId) => {
      const step = await Step(reqId, read);
      expect(step.value).to.have.property("changeType", "modified");
      expect(step.value).to.have.deep.property("oldValue", {
        _id: "a",
        price: 1,
      });
      expect(step.value).to.have.deep.property("newValue", {
        _id: "a",
        price: 2,
      });
    });
  });

  it("carries both sides of an update even where one no longer matches the filter", async () => {
    const { read } = Reader([
      { scanned_to: "0" },
      {
        scanned_to: "1",
        events: [
          {
            op: "modified",
            old: Side({ _id: "a", price: 50 }, true),
            new: Side({ _id: "a", price: 200 }, false),
          },
        ],
      },
    ]);
    await Feed(async (reqId) => {
      const step = await Step(reqId, read);
      expect(step.value).to.have.deep.property("oldValue", {
        _id: "a",
        price: 50,
      });
      expect(step.value).to.have.deep.property("newValue", {
        _id: "a",
        price: 200,
      });
    });
  });

  it("buffers a batch and answers it one event per read, in order", async () => {
    const { read } = Reader([
      { scanned_to: "0" },
      {
        scanned_to: "2",
        events: [
          { op: "added", old: ABSENT, new: Side({ _id: "first" }) },
          { op: "added", old: ABSENT, new: Side({ _id: "second" }) },
        ],
      },
    ]);
    await Feed(async (reqId) => {
      const one = await Step(reqId, read);
      const two = await Step(reqId, read);
      expect(one.value).to.have.nested.property("newValue._id", "first");
      expect(two.value).to.have.nested.property("newValue._id", "second");
    });
  });
});

describe("the three ways a change feed ends", () => {
  it("rejects when the watermark has fallen below what the reaper deleted", async () => {
    const { read } = Reader([{ scanned_to: "5" }, { high_water: "9" }]);
    await Feed(async (reqId) => {
      await Step(reqId, read).then(
        () => expect.fail("a lapsed feed must not continue"),
        (err: unknown) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("changeRetentionMs");
          expect(err.message).to.contain("events 6 through 9");
          expect(err.message).to.contain(`${SCHEMA_ID}.${TABLE_ID}`);
        },
      );
    });
  });

  it("does not reject on a high-water it is still above", async () => {
    const { read } = Reader([
      { scanned_to: "9" },
      {
        high_water: "9",
        events: [{ op: "added", old: ABSENT, new: Side({ _id: "a" }) }],
      },
    ]);
    await Feed(async (reqId) => {
      const step = await Step(reqId, read);
      expect(step.done).to.equal(false);
    });
  });

  it("rejects when the server restarted under it, since the log did not survive", async () => {
    const { read } = Reader([
      { epoch: EPOCH, scanned_to: "5" },
      { epoch: LATER_EPOCH },
    ]);
    await Feed(async (reqId) => {
      await Step(reqId, read).then(
        () => expect.fail("a restarted server must not be read through"),
        (err: unknown) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("restarted");
          expect(err.message).to.contain(`${SCHEMA_ID}.${TABLE_ID}`);
        },
      );
    });
  });

  it("answers done rather than rejecting when it was closed", async () => {
    const { read } = Reader([{ scanned_to: "0" }, { events: [] }]);
    const reqId = NewReqId();
    const pending = WhileConfigured(() => Step(reqId, read));
    await CloseOneFeed(reqId);
    expect(await pending).to.deep.equal({ done: true, value: undefined });
  });

  it("resolves a waiting read when the connection is being torn down", async () => {
    const { read } = Reader([{ scanned_to: "0" }, { events: [] }]);
    const reqId = NewReqId();
    const pending = WhileConfigured(() => Step(reqId, read));
    await CloseAllFeeds();
    expect(await pending).to.deep.equal({ done: true, value: undefined });
  });
});

describe("the change feed registry", () => {
  it("knows a reqId only once it has been read", async () => {
    const reqId = NewReqId();
    expect(IsRegisteredFeed(reqId)).to.equal(false);
    const { read } = Reader([{ scanned_to: "0" }, { events: [] }]);
    const pending = WhileConfigured(() => Step(reqId, read));
    expect(IsRegisteredFeed(reqId)).to.equal(true);
    await CloseOneFeed(reqId);
    await pending;
  });

  it("closes a reqId it has never seen, so a read arriving after it answers done", async () => {
    const reqId = NewReqId();
    await CloseOneFeed(reqId);
    const { read } = Reader([{ scanned_to: "0" }, { events: [] }]);
    expect(await WhileConfigured(() => Step(reqId, read))).to.deep.equal({
      done: true,
      value: undefined,
    });
  });
});

describe("dispatching an iteration between a cursor and a feed", () => {
  it("routes a query ending in 'changes' to the feed registry", async () => {
    const reqId = NewReqId();
    const pending = WhileConfigured(() =>
      ReadCursor(reqId, Stages()).then(
        () => undefined,
        () => undefined,
      ),
    );
    expect(IsRegisteredFeed(reqId)).to.equal(true);
    await CloseOneFeed(reqId);
    await pending;
  });

  it("leaves a query that does not end in 'changes' to the cursor path", async () => {
    const reqId = NewReqId();
    await WhileConfigured(() =>
      ReadCursor(reqId, Stages().slice(0, -1)).then(
        () => undefined,
        () => undefined,
      ),
    );
    expect(IsRegisteredFeed(reqId)).to.equal(false);
    await CloseCursor(reqId);
  });

  it("closes a feed through the one entry point both kinds share", async () => {
    const { read } = Reader([{ scanned_to: "0" }, { events: [] }]);
    const reqId = NewReqId();
    const opened = WhileConfigured(() => Step(reqId, read));
    await CloseCursor(reqId);
    expect(await opened).to.deep.equal({ done: true, value: undefined });
    expect(await WhileConfigured(() => Step(reqId, read))).to.deep.equal({
      done: true,
      value: undefined,
    });
  });
});
