import { expect } from "chai";

import { WhileConfigured } from "./spec-fixture";
import type { QueryStage } from "../../implementations/database/utils";
import type { TableOrigin } from "../../implementations/database/relation";
import { CloseCursor, ReadCursor } from "../../implementations/database/query";
import {
  CloseAllFeeds,
  CloseOneFeed,
  type FeedEnvironment,
  type FeedReader,
  IsRegisteredFeed,
  ReadFeedEvent,
} from "../../implementations/database/feeds";

/**
 * A feed that never opens against a live schema, driven entirely through the reader seam.
 *
 * These `reqId`s are negative because the interface's own counter starts at 0
 * and counts up, so a fixture using a positive id would collide with a lambda or a cursor the
 * process allocated for something else.
 */
let nextReqId = -1000;
const NewReqId = () => nextReqId--;

const SCHEMA_ID = "shop";
const TABLE_ID = "orders";

const EPOCH = new Date("2026-08-12T09:00:00.000Z");
const LATER_EPOCH = new Date("2026-08-12T10:00:00.000Z");

const SETTLE_MS = 60;

function Stages(...between: string[]): QueryStage[] {
  return [
    { stage: "schema", options: { id: SCHEMA_ID }, args: [] },
    { stage: "instance", options: { id: "default" }, args: [] },
    { stage: "table", options: { id: TABLE_ID }, args: [] },
    ...between.map((stage) => ({ stage, args: [] })),
    { stage: "changes", args: [] },
  ];
}

interface Answer {
  epoch?: Date;
  high_water?: string | null;
  scanned_to?: string | null;
  events?: unknown[];
}

interface Asked {
  sql: string;
  params: unknown[];
}

/**
 * A table with no declared fields, so every logged key reads out of the overflow document.
 *
 * `index` answers the name itself, which is `IndexFields`' own undeclared-field fallback — the
 * feed's selection stages resolve through it exactly as the read path does.
 */
const FIELDLESS: TableOrigin = {
  schemaId: SCHEMA_ID,
  tableId: TABLE_ID,
  model: { fields: {} },
  index: (name) => [name],
};

/** Answers each statement in turn, recording what it was asked; the last answer repeats. */
function Reader(answers: Answer[]) {
  const asked: Asked[] = [];
  const read: FeedReader = (sql, params) => {
    asked.push({ sql, params });
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    return Promise.resolve({
      rows: [
        {
          epoch: answer.epoch ?? EPOCH,
          high_water: answer.high_water ?? null,
          scanned_to: answer.scanned_to ?? null,
          scanned_count: (answer.events ?? []).length,
          events: (answer.events ?? []) as never,
        },
      ],
    });
  };
  return {
    read: {
      read,
      install: () => Promise.resolve(),
      origin: () => FIELDLESS,
      listen: () => Promise.resolve(),
    },
    asked,
  };
}

/** One side of an event as the laterals answer it: what it projected, and whether it matched. */
function Side<Doc>(doc: Doc, matched = true) {
  return { doc, matched };
}

const ABSENT = Side(null, false);

/**
 * Runs a feed spec with *a* configuration in place for the whole of it.
 *
 * `WithOptions` cannot serve here: it restores synchronously, and every generated name a feed reads
 * — the physical schema and table it watches — is resolved one await later, inside the open.
 */
function Feed<T>(body: (reqId: number) => Promise<T>) {
  const reqId = NewReqId();
  return WhileConfigured(() => body(reqId)).finally(() => CloseOneFeed(reqId));
}

/** Reads one event, with the environment supplied so nothing touches a pool. */
function Step(reqId: number, read: FeedEnvironment, ...between: string[]) {
  return ReadFeedEvent(reqId, Stages(...between), read);
}

describe("a change feed's refusals", () => {
  it("refuses a stage that needs an order, naming the stage and the position", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, "orderBy").then(
        () => expect.fail("a feed has no total order to sort by"),
        (err: Error) => {
          expect(err.message).to.contain("'orderBy'");
          expect(err.message).to.contain("'changes'");
        },
      );
    });
  });

  it("refuses a stage that needs a finite relation, for the reason it names", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, "count").then(
        () => expect.fail("a feed is not finite"),
        (err: Error) => {
          expect(err.message).to.contain("'count'");
          expect(err.message).to.contain("total order or a finite relation");
        },
      );
    });
  });

  it("refuses a terminal write before a feed, which is legal one level out", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, "insert").then(
        () => expect.fail("a feed writes nothing"),
        (err: Error) => {
          expect(err.message).to.contain("'insert'");
          expect(err.message).to.contain("'changes'");
        },
      );
    });
  });

  it("keeps the fold's own wording for a stage nothing knows, which is a typo", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, "filtr").then(
        () => expect.fail("no such stage"),
        (err: Error) => {
          expect(err.message).to.contain("Unsupported query stage 'filtr'");
          expect(err.message).to.not.contain("'changes'");
        },
      );
    });
  });

  it("names the first unsupported stage rather than the last", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, "orderBy", "slice").then(
        () => expect.fail("neither stage is supported"),
        (err: Error) => {
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
        (err: Error) => {
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
        (err: Error) => {
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
