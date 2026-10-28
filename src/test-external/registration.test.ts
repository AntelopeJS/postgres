import { expect } from "chai";
import {
  Schema,
  type SchemaDefinition,
  type TableDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../logger";
import {
  GetTableShape,
  WaitForSchemaReady,
} from "../implementations/database/schema";

const SCHEMA_ID = "sales";

type LogMethod = "Warn" | "Info";

function Table(
  fields: TableDefinition["fields"],
  indexes = {},
): TableDefinition {
  return { fields, indexes };
}

async function Register(definition: SchemaDefinition): Promise<void> {
  new Schema(SCHEMA_ID, definition);
  await WaitForSchemaReady(SCHEMA_ID);
}

async function Refusal(definition: SchemaDefinition): Promise<string> {
  try {
    await Register(definition);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("registration was expected to fail");
}

async function Logged(
  method: LogMethod,
  work: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const original = Logger[method].bind(Logger);
  Logger[method] = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    Logger[method] = original;
  }
  return lines;
}

function KeyColumns(tableId: string): string[] | undefined {
  return GetTableShape(SCHEMA_ID, tableId).external?.key?.map(
    (key) => key.column,
  );
}

describe("registering an external schema", () => {
  it("fails, naming the table, when a declared table does not exist", async () => {
    const message = await Refusal({ invoices: Table({ total: "number" }) });
    expect(message)
      .to.contain("sales.invoices")
      .and.to.contain("does not have");
  });

  it("fails, naming field and column, when a declared column does not exist", async () => {
    const message = await Refusal({ accounts: Table({ nickname: "string" }) });
    expect(message)
      .to.contain("sales.accounts.nickname")
      .and.to.contain('"nickname"');
  });

  it("fails when a declared type cannot read its column", async () => {
    const message = await Refusal({
      accounts: Table({ external_ref: "number" }),
    });
    expect(message)
      .to.contain("sales.accounts.external_ref")
      .and.to.contain("uuid");
  });

  it("fails when _id is declared on a relation with no key", async () => {
    const message = await Refusal({
      raw_log: Table({ _id: "string", msg: "string" }),
    });
    expect(message)
      .to.contain("sales.raw_log._id")
      .and.to.contain("no primary key");
  });

  it("registers _id declared on a table with a primary key", async () => {
    await Register({
      accounts: Table({ _id: "string", id: "string", name: "string" }),
    });
    expect(GetTableShape(SCHEMA_ID, "accounts").external?.table).to.equal(
      "accounts",
    );
  });

  it("registers a lossy pairing and warns once, saying what is lost", async () => {
    const warnings = await Logged("Warn", () =>
      Register({
        accounts: Table({ big_counter: "number", revenue: "string" }),
      }),
    );
    const lossy = warnings.filter((line) => line.includes("lossily"));
    expect(lossy).to.have.length(1);
    expect(lossy[0])
      .to.contain("sales.accounts.big_counter")
      .and.to.contain("2^53");
  });

  it("registers a declared index the database does not back, and warns that it may be slow", async () => {
    const warnings = await Logged("Warn", () =>
      Register({
        accounts: Table(
          { name: "string", active: "boolean" },
          { byActive: { fields: ["active"] } },
        ),
      }),
    );
    expect(warnings.filter((line) => line.includes("byActive"))).to.have.length(
      1,
    );
  });

  it("does not warn about a declared index the database backs", async () => {
    const warnings = await Logged("Warn", () =>
      Register({ accounts: Table({ name: "string" }, { name: {} }) }),
    );
    expect(
      warnings.filter((line) => line.includes("Index 'name'")),
    ).to.deep.equal([]);
  });
});

describe("the key an external relation's _id aliases", () => {
  before(async () => {
    await Register({
      accounts: Table({ name: "string" }),
      tags: Table({ label: "string" }),
      order_lines: Table({ sku: "string" }),
      events: Table({ msg: "string" }),
      raw_log: Table({ msg: "string" }),
      big_accounts: Table({ account_name: "string" }),
      daily_signups: Table({ n: "number" }),
    });
  });

  it("is a table's single-column primary key", () => {
    expect(KeyColumns("accounts")).to.deep.equal(["id"]);
  });

  it("is a partitioned table's primary key, declared on the parent", () => {
    expect(KeyColumns("tags")).to.deep.equal(["id"]);
  });

  it("is every column of a composite primary key, in key order", () => {
    expect(KeyColumns("order_lines")).to.deep.equal(["order_id", "line_no"]);
  });

  it("is the narrowest unique index over NOT NULL columns when there is no primary key", () => {
    expect(KeyColumns("events")).to.deep.equal(["event_ref"]);
  });

  for (const relation of ["raw_log", "big_accounts", "daily_signups"]) {
    it(`is absent on ${relation}, which has no primary key and no NOT NULL unique index`, () => {
      expect(KeyColumns(relation)).to.equal(undefined);
    });
  }
});
