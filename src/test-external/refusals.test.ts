import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { Native, RegisterSales, type SalesTables } from "./sales";

let sales: Schema<SalesTables>;

function Accounts() {
  return sales.instance().table("accounts");
}

async function Refusal(work: () => PromiseLike<unknown>): Promise<string> {
  try {
    await work();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the request was expected to be refused");
}

/** The first event a feed would deliver, which is where an iterated query first reaches the module. */
async function FirstEvent(feed: AsyncIterable<unknown>): Promise<unknown> {
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

  const WRITES: [string, () => PromiseLike<unknown>][] = [
    ["insert", () => Accounts().insert({ name: "New" })],
    ["update", () => Accounts().get("1").update({ name: "Changed" })],
    ["replace", () => Accounts().get("1").replace({ name: "Replaced" })],
    ["delete", () => Accounts().get("1").delete()],
    [
      "atomicMutation",
      () =>
        Accounts().atomicMutation("1", {
          type: "update",
          revisionField: "name",
          expectedRevision: "Acct 1",
          nextRevision: "Acct one",
          patch: {},
        }),
    ],
  ];

  for (const [stage, write] of WRITES) {
    it(`refuses ${stage}, naming the stage and the relation, and writes nothing`, async () => {
      const message = await Refusal(write);
      expect(message).to.contain(stage).and.to.contain('"sales"."accounts"');
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

  for (const [description, read] of [
    ["get", () => sales.instance().table("raw_log").get("1")],
    [
      "getAll without an index",
      () => sales.instance().table("raw_log").getAll(["1"]),
    ],
    [
      "getAll by _id",
      () => sales.instance().table("raw_log").getAll(["1"], "_id"),
    ],
  ] as [string, () => PromiseLike<unknown>][]) {
    it(`refuses ${description} on a relation with no key, naming it`, async () => {
      const message = await Refusal(read);
      expect(message).to.contain('"sales"."raw_log"').and.to.contain("no _id");
    });
  }

  it("still reads a keyless relation by a field", async () => {
    const rows = await sales.instance().table("raw_log").getAll(["r1"], "msg");
    expect(rows).to.have.length(1);
  });
});
