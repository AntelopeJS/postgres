import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";
import type { StagedObject } from "@antelopejs/interface-database/common";

import { AcquireClient } from "../connection";
import { Render } from "../implementations/database/relation";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileExpression } from "../implementations/database/expression";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import { Native, NativeCount, RegisterSales, type SalesTables } from "./sales";

type Row = Record<string, unknown>;

type IntegerComparison = "gt" | "ge" | "lt" | "le" | "eq";

let sales: Schema<SalesTables>;

function Table(tableId: string) {
  return sales.instance().table(tableId);
}

/**
 * The plan the database chooses for a read, with sequential scans priced out, so the answer says
 * whether an index *can* serve the read rather than whether the statistics of the day prefer it.
 */
async function Plan(query: StagedObject): Promise<string> {
  const context = new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
  const root = BuildRoot(query.build(), context);
  const sql = Render(ApplyStages(root.relation, root.rest, context));
  const client = await AcquireClient();
  try {
    await client.query("SET enable_seqscan = off");
    const plan = await client.query(`EXPLAIN ${sql}`, context.params.all());
    return plan.rows.map((row: Row) => String(row["QUERY PLAN"])).join("\n");
  } finally {
    await client.query("RESET enable_seqscan");
    client.release();
  }
}

describe("an external key that its column cannot hold", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  for (const [table, key] of [
    ["contacts", "not-a-uuid"],
    ["accounts", "42abc"],
    ["accounts", "99999999999999999999"],
    ["order_lines", "not json"],
    ["order_lines", '"0"'],
    ["order_lines", '["0"]'],
    ["order_lines", '["0", "1", "9"]'],
    ["order_lines", '["x", "1"]'],
  ]) {
    it(`gets nothing for ${key} on ${table}, rather than failing the request`, async () => {
      expect(await Table(table).get(key)).to.equal(undefined);
    });
  }

  it("filters nothing for an enum label the type does not have", async () => {
    const total = await Table("accounts")
      .filter((row) => row.key("status").eq("archived"))
      .count();
    expect(total).to.equal(0);
  });
});

describe("the indexes that serve reads of an external relation", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("gets by a bigint _id through the primary key index", async () => {
    expect(await Plan(Table("accounts").get("42"))).to.contain("accounts_pkey");
  });

  it("gets by a composite _id through the primary key index", async () => {
    expect(await Plan(Table("order_lines").get('["4", "2"]'))).to.contain(
      "order_lines_pkey",
    );
  });

  it("looks a foreign key up through the referenced primary key index", async () => {
    const query = Table("contacts")
      .slice(0, 3)
      .lookup(Table("accounts"), "account_id", "_id");
    expect(await Plan(query)).to.contain("accounts_pkey");
  });

  it("ranges over a naive timestamp through its own index", async () => {
    const query = Table("contacts").filter((row) =>
      row
        .key("created_at")
        .ge(new Date("2026-03-02T00:00:00Z"))
        .and(row.key("created_at").lt(new Date("2026-03-03T00:00:00Z"))),
    );
    expect(await Plan(query)).to.contain("contacts_created");
  });
});

describe("numbers read from an external relation's exact types", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("sums a numeric column exactly", async () => {
    const total = await Table("accounts")
      .filter((row) => row.key("active").eq(true))
      .sum("revenue");
    const [expected] = await Native<{ total: number }>(
      "SELECT sum(revenue)::double precision AS total FROM sales.accounts WHERE active",
    );
    expect(total).to.equal(expected.total);
  });

  for (const [method, operator] of [
    ["gt", ">"],
    ["ge", ">="],
    ["lt", "<"],
    ["le", "<="],
    ["eq", "="],
  ] as [IntegerComparison, string][]) {
    it(`keeps the meaning of '${operator} 5.5' on an integer column`, async () => {
      const total = await Table("accounts")
        .filter((row) => row.key("score")[method](5.5))
        .count();
      expect(total).to.equal(
        await NativeCount(
          `SELECT count(*) FROM sales.accounts WHERE score ${operator} 5.5`,
        ),
      );
    });
  }
});

describe("inequality against an external column's own type", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  for (const [field, value, expected] of [
    ["ref", "not-a-uuid", 2],
    ["ref", "", 2],
    ["n", 5.5, 2],
    ["n", 5, 1],
  ] as [string, string | number, number][]) {
    it(`answers ${field} ne ${JSON.stringify(value)} as the complement of eq, keeping NULL rows`, async () => {
      const unequal = await Table("flags")
        .filter((row) => row.key(field).ne(value))
        .count();
      const equal = await Table("flags")
        .filter((row) => row.key(field).eq(value))
        .count();
      expect(unequal).to.equal(expected);
      expect(unequal + equal).to.equal(2);
    });
  }
});
