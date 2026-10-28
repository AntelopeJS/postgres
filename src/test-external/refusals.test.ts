import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { Native, RegisterSales, type SalesTables } from "./sales";

let sales: Schema<SalesTables>;

function Accounts() {
  return sales.instance().table("accounts");
}

async function Refusal<T extends PromiseLike<unknown>>(
  work: () => T,
): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("the request was expected to be refused");
}

/** The first event a feed would deliver, which is where an iterated query first reaches the module. */
async function FirstEvent<T>(
  feed: AsyncIterable<T>,
): Promise<IteratorResult<T>> {
  const iterator = feed[Symbol.asyncIterator]();
  try {
    return await iterator.next();
  } finally {
    await iterator.return?.();
  }
}

async function AccountsUnchanged(): Promise<void> {
  const [row] = await Native<{ name: string; count: string }>(
    "SELECT (SELECT name FROM sales.accounts WHERE id = 1) AS name, (SELECT count(*) FROM sales.accounts) AS count",
  );
  expect(row).to.deep.equal({ name: "Acct 1", count: "20000" });
}

describe("what an external relation refuses", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  after(AccountsUnchanged);

  const WRITES = [
    { stage: "insert", write: () => Accounts().insert({ name: "New" }) },
    {
      stage: "update",
      write: () => Accounts().get("1").update({ name: "Changed" }),
    },
    {
      stage: "replace",
      write: () => Accounts().get("1").replace({ name: "Replaced" }),
    },
    { stage: "delete", write: () => Accounts().get("1").delete() },
    {
      stage: "atomicMutation",
      write: () =>
        Accounts().atomicMutation("1", {
          type: "update",
          revisionField: "name",
          expectedRevision: "Acct 1",
          nextRevision: "Acct one",
          patch: {},
        }),
    },
  ];

  for (const { stage, write } of WRITES) {
    const expected = stage === "atomicMutation" ? stage : "may not write to";
    it(`refuses ${stage} on a relation the connected role may not write, naming it, and writes nothing`, async () => {
      const message = await Refusal(() => write());
      expect(message).to.contain(expected).and.to.contain('"sales"."accounts"');
    });
  }

  it("refuses changes(), since the adapter keeps no change log on the client's database", async () => {
    const message = await Refusal(() =>
      FirstEvent(Accounts().changes() as never),
    );
    expect(message)
      .to.contain("changes()")
      .and.to.contain('"sales"."accounts"');
  });

  it("refuses creating and destroying an instance", async () => {
    expect(await Refusal(() => sales.createInstance("t1"))).to.contain(
      "createInstance",
    );
    expect(await Refusal(() => sales.destroyInstance("t1"))).to.contain(
      "destroyInstance",
    );
  });

  it("lists no instances", async () => {
    expect(await sales.listInstances()).to.deep.equal([]);
  });

  for (const { description, read } of [
    {
      description: "get",
      read: () => sales.instance().table("raw_log").get("1"),
    },
    {
      description: "getAll without an index",
      read: () => sales.instance().table("raw_log").getAll(["1"]),
    },
    {
      description: "getAll by _id",
      read: () => sales.instance().table("raw_log").getAll(["1"], "_id"),
    },
  ]) {
    it(`refuses ${description} on a relation with no key, naming it`, async () => {
      const message = await Refusal(() => read());
      expect(message).to.contain('"sales"."raw_log"').and.to.contain("no _id");
    });
  }

  it("still reads a keyless relation by a field", async () => {
    const rows = await sales.instance().table("raw_log").getAll(["r1"], "msg");
    expect(rows).to.have.length(1);
  });
});
