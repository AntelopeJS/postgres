import { expect } from "chai";
import {
  CROSS_INSTANCE,
  type Schema,
} from "@antelopejs/interface-database/schema";

import {
  REGISTRATION_TIMEOUT_MS,
  RegisterSales,
  type SalesRow,
  type SalesTables,
} from "../test-external/sales";

let sales: Schema<SalesTables>;

async function Refusal(work: () => Promise<void>): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("the request was expected to be refused");
}

async function NameOfFirstAccount(
  instance?: string,
): Promise<SalesRow[string] | undefined> {
  const row = await sales.instance(instance).table("accounts").get("1").run();
  return row?.name;
}

async function Iterated(instance: string): Promise<SalesRow[]> {
  const rows: SalesRow[] = [];
  for await (const row of sales.instance(instance).table("flags")) {
    rows.push(row);
  }
  return rows;
}

describe("schema instances as databases", () => {
  before(async function () {
    this.timeout(REGISTRATION_TIMEOUT_MS);
    sales = await RegisterSales();
  });

  it("lists the ids the list query answers", async () => {
    expect(await sales.listInstances().run()).to.deep.equal([
      "alpha",
      "beta",
      "drifted",
    ]);
  });

  it("refuses an instance whose database differs, naming every difference", async () => {
    const message = await Refusal(async () => {
      await NameOfFirstAccount("drifted");
    });
    expect(message).to.contain(`database "antelopejs_tenant_drifted"`);
    expect(message).to.contain(`"sales"."flags" has no column "n"`);
    expect(message).to.contain(
      `"sales"."w_serial"."label" is character varying(40), where text was registered`,
    );
    expect(message).to.contain(`"sales"."raw_log" does not exist`);
  });

  it("refuses a cursor and a write on that instance too", async () => {
    const iterated = await Refusal(async () => {
      await Iterated("drifted");
    });
    const written = await Refusal(async () => {
      await sales
        .instance("drifted")
        .table("w_serial")
        .insert({ label: "never written" })
        .run();
    });
    expect(iterated).to.contain("as it was registered");
    expect(written).to.contain("as it was registered");
  });

  it("keeps serving the other instances beside a refused one", async () => {
    expect(await NameOfFirstAccount("alpha")).to.equal("alpha Acct 1");
    expect(await NameOfFirstAccount()).to.equal("Acct 1");
  });

  it("reads the default instance in the database of url", async () => {
    expect(await NameOfFirstAccount()).to.equal("Acct 1");
  });

  it("reads a named instance in its own database", async () => {
    expect(await NameOfFirstAccount("alpha")).to.equal("alpha Acct 1");
    expect(await NameOfFirstAccount("beta")).to.equal("beta Acct 1");
    expect(await NameOfFirstAccount()).to.equal("Acct 1");
  });

  it("iterates a cursor in the database of its instance", async () => {
    const alpha = await Iterated("alpha");
    const beta = await Iterated("beta");
    expect(alpha.find((row) => row.id === 1)?.n).to.equal(100);
    expect(beta.find((row) => row.id === 1)?.n).to.equal(101);
  });

  it("writes in the database of its instance and in no other", async () => {
    const serial = (instance?: string) =>
      sales.instance(instance).table("w_serial");
    const count = async (instance?: string) =>
      (await serial(instance).run()).length;
    const before = {
      alpha: await count("alpha"),
      beta: await count("beta"),
      main: await count(),
    };
    await serial("alpha").insert({ label: "written in alpha" }).run();
    expect(await count("alpha")).to.equal(before.alpha + 1);
    expect(await count("beta")).to.equal(before.beta);
    expect(await count()).to.equal(before.main);
  });

  it("refuses an instance the list does not answer", async () => {
    for (const id of ["gamma", 'alpha"; DROP TABLE sales.accounts; --']) {
      const message = await Refusal(async () => {
        await NameOfFirstAccount(id);
      });
      expect(message).to.contain("names no database");
    }
    expect(await NameOfFirstAccount("alpha")).to.equal("alpha Acct 1");
  });

  it("refuses CROSS_INSTANCE by name", async () => {
    const message = await Refusal(async () => {
      await sales.instance(CROSS_INSTANCE).table("accounts").get("1").run();
    });
    expect(message).to.contain("CROSS_INSTANCE");
  });

  it("still refuses to create or destroy an instance", async () => {
    const created = await Refusal(async () => {
      await sales.createInstance("gamma").run();
    });
    const destroyed = await Refusal(async () => {
      await sales.destroyInstance("alpha").run();
    });
    expect(created).to.contain("manages instances");
    expect(await sales.listInstances().run()).to.not.contain("gamma");
    expect(destroyed).to.contain("manages instances");
  });
});
