import { expect } from "chai";
import {
  CROSS_INSTANCE,
  type Schema,
} from "@antelopejs/interface-database/schema";

import {
  Native,
  NativeCount,
  RegisterSales,
  type SalesRow as Row,
  type SalesTables,
} from "./sales";

const PARIS = "Europe/Paris";

let sales: Schema<SalesTables>;

function Accounts() {
  return sales.instance().table("accounts");
}

function Contacts() {
  return sales.instance().table("contacts");
}

function Day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function NextDay(iso: string): Date {
  return new Date(Day(iso).getTime() + 86_400_000);
}

describe("listing an external relation as a TableView does", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("lists with an enum filter, a (?i) search, a sort and a page, as a TableView does", async () => {
    const rows = await Accounts()
      .orderBy("name", "desc")
      .filter((row) => row.key("status").eq("active"))
      .filter((row) => row.key("name").match("(?i)acct 1"))
      .slice(0, 5)
      .pluck("_internal", "_id", "name", "status");
    const expected = await Native<Row>(
      `SELECT id::text AS "_id", name, status::text AS status FROM sales.accounts
       WHERE status = 'active' AND name ~* 'acct 1' ORDER BY name DESC LIMIT 5`,
    );
    expect(rows).to.deep.equal(expected);
  });

  it("counts the same filtered rows, as a TableView's total does", async () => {
    const total = await Accounts()
      .filter((row) => row.key("status").eq("active"))
      .filter((row) => row.key("name").match("(?i)acct 1"))
      .count();
    expect(total).to.equal(
      await NativeCount(
        "SELECT count(*) FROM sales.accounts WHERE status = 'active' AND name ~* 'acct 1'",
      ),
    );
  });

  it("filters an integer and a numeric column by the numbers the DMS parses", async () => {
    const total = await Accounts()
      .filter((row) => row.key("score").gt(97))
      .filter((row) => row.key("revenue").ge(267000))
      .count();
    expect(total).to.equal(
      await NativeCount(
        "SELECT count(*) FROM sales.accounts WHERE score > 97 AND revenue >= 267000",
      ),
    );
  });

  for (const [table, column] of [
    ["accounts", "created_at"],
    ["accounts", "signed_on"],
    ["contacts", "created_at"],
  ]) {
    it(`answers a date filter 'is' on ${table}.${column} as that UTC day`, async () => {
      const day = "2026-03-02";
      const total = await sales
        .instance()
        .table(table)
        .filter((row) =>
          row
            .key(column)
            .ge(Day(day))
            .and(row.key(column).lt(NextDay(day))),
        )
        .count();
      expect(total).to.equal(
        await NativeCount(
          `SELECT count(*) FROM sales.${table}
           WHERE (${column})::timestamp >= $1::timestamp AND (${column})::timestamp < $1::timestamp + interval '1 day'`,
          [day],
        ),
      );
      expect(total).to.be.greaterThan(0);
    });
  }

  it("searches a date column through its ISO rendering, as a TableView search does", async () => {
    const total = await Accounts()
      .filter((row) => row.key("created_at").match("(?i)2026-01-02T0"))
      .count();
    expect(total).to.equal(10);
  });

  it("searches enum and uuid columns through their text", async () => {
    const total = await Accounts()
      .filter((row) =>
        row
          .key("status")
          .match("(?i)CHURN")
          .or(row.key("external_ref").match("(?i)^0")),
      )
      .count();
    expect(total).to.equal(
      await NativeCount(
        "SELECT count(*) FROM sales.accounts WHERE status::text ~* 'churn' OR external_ref::text ~* '^0'",
      ),
    );
  });
});

describe("reading an external row by key", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("gets a row by its bigint key as a string _id, with exact bigints and true instants", async () => {
    const row = await Accounts()
      .get("42")
      .pluck("_id", "id", "big_counter", "signed_on", "last_seen");
    expect(row).to.deep.equal({
      _id: "42",
      id: "42",
      big_counter: "9007199254741035",
      signed_on: new Date("2026-02-12T00:00:00.000Z"),
      last_seen: new Date("2026-01-01T00:42:00.000Z"),
    });
  });

  it("decodes dates the same whatever the Node process's time zone", async () => {
    const original = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const row = await Accounts().get("42").pluck("signed_on", "last_seen");
      expect(row).to.deep.equal({
        signed_on: new Date("2026-02-12T00:00:00.000Z"),
        last_seen: new Date("2026-01-01T00:42:00.000Z"),
      });
    } finally {
      process.env.TZ = original;
    }
  });

  it("reads a whole row in row mode with _id first and every declared field", async () => {
    const row = await Accounts().get("7");
    expect(Object.keys(row)[0]).to.equal("_id");
    expect(row).to.include({
      _id: "7",
      id: "7",
      name: "Acct 7",
      status: "active",
    });
    expect(row.tags).to.deep.equal(["t2"]);
    expect(row.meta).to.deep.equal({ k: 7 });
  });

  it("answers getAll by _id with the rows whose key matches, and nothing for a key that cannot", async () => {
    const [known] = await Native<{ id: string }>(
      "SELECT contact_id::text AS id FROM sales.contacts ORDER BY first_name LIMIT 1",
    );
    const rows = await Contacts().getAll([known.id, "not-a-uuid"], "_id");
    expect(rows.map((row) => row._id)).to.deep.equal([known.id]);
  });
});

describe("reading across external relations", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("resolves a foreign field: lookup from a bigint foreign key to the account's _id", async () => {
    const rows = await Contacts()
      .orderBy("first_name", "asc")
      .slice(0, 3)
      .lookup(Accounts().pluck("_internal", "_id", "name"), "account_id", "_id")
      .pluck("first_name", "account_id");
    const expected = await Native<Row>(
      `SELECT c.first_name, jsonb_build_object('_id', a.id::text, 'name', a.name) AS account_id
       FROM sales.contacts c JOIN sales.accounts a ON a.id = c.account_id
       ORDER BY c.first_name LIMIT 3`,
    );
    expect(rows).to.deep.equal(expected);
  });

  it("buckets a builder series by day in Europe/Paris over a naive timestamp read as UTC", async () => {
    const series = await Contacts()
      .filter((row) =>
        row.key("created_at").ge(new Date("2026-03-01T00:00:00Z")),
      )
      .map((row) => ({
        bucket: row
          .key("created_at")
          .year(PARIS)
          .mul(100)
          .add(row.key("created_at").month(PARIS))
          .mul(100)
          .add(row.key("created_at").day(PARIS)),
      }))
      .group("bucket", (rows, group) => ({ x: group, y: rows.count() }))
      .orderBy("x", "asc")
      .slice(0, 3);
    const expected = await Native<{ x: string; y: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE '${PARIS}', 'YYYYMMDD') AS x, count(*) AS y
       FROM sales.contacts GROUP BY 1 ORDER BY 1 LIMIT 3`,
    );
    expect(series).to.deep.equal(
      expected.map((bucket) => ({ x: Number(bucket.x), y: Number(bucket.y) })),
    );
  });

  it("reads an undeclared key, such as the _internal data-api plucks, as absent", async () => {
    const row = await Accounts().get("1").pluck("_internal", "name");
    expect(row).to.deep.equal({ name: "Acct 1" });
    const total = await Accounts()
      .filter((row) => row.key("nickname").eq("x"))
      .count();
    expect(total).to.equal(0);
  });
});

describe("the _id of relations without a single-column primary key", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("answers a composite key's _id as its parts, and gets the row back by it", async () => {
    const [first] = await sales
      .instance()
      .table("order_lines")
      .orderBy("_id")
      .slice(0, 1);
    expect(first._id).to.equal('["0", "1"]');
    const again = await sales
      .instance()
      .table("order_lines")
      .get(String(first._id));
    expect(again).to.deep.equal(first);
  });

  it("answers _id from the unique index of a table without a primary key", async () => {
    const row = await sales.instance().table("events").orderBy("at").nth(0);
    if (row === null) throw new Error("the relation answered no row");
    expect(row._id).to.equal(row.event_ref);
  });

  for (const relation of ["raw_log", "big_accounts", "daily_signups"]) {
    it(`counts ${relation}, which has no key, and its rows answer no _id`, async () => {
      const table = sales.instance().table(relation);
      expect(await table.count()).to.equal(
        await NativeCount(`SELECT count(*) FROM sales.${relation}`),
      );
      const [row] = await table.slice(0, 1);
      expect(row).to.not.have.property("_id");
    });
  }
});

describe("instances over an external relation", () => {
  before(async () => {
    sales = await RegisterSales();
  });

  it("reads every row through CROSS_INSTANCE, since an external relation has no instances", async () => {
    expect(
      await sales.instance(CROSS_INSTANCE).table("accounts").count(),
    ).to.equal(20000);
  });

  it("refuses a named instance rather than answer rows nobody scoped to it", async () => {
    let refusal: Error | undefined;
    try {
      await sales.instance("tenant-1").table("accounts").count();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      refusal = err;
    }
    expect(refusal?.message)
      .to.contain('"sales"."accounts"')
      .and.to.contain("tenant-1");
  });
});
