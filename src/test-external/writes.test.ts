import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { AcquireClient } from "../connection";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileExpression } from "../implementations/database/expression";
import { SplitWrite, CompileWrite } from "../implementations/database/writes";
import { WriteTargetOf } from "../implementations/database/writes-shared";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import type { ExternalWriteError } from "../implementations/database/external-errors";
import { Native, NativeCount, RegisterSales, type SalesTables } from "./sales";

type Row = Record<string, unknown>;

let sales: Schema<SalesTables>;

function Table(tableId: string) {
  return sales.instance().table(tableId);
}

async function Failure(
  work: () => PromiseLike<unknown>,
): Promise<ExternalWriteError> {
  try {
    await work();
  } catch (err) {
    return err as ExternalWriteError;
  }
  throw new Error("the write was expected to fail");
}

async function Reset(): Promise<void> {
  await Native("DELETE FROM sales.w_items");
  await Native("DELETE FROM sales.w_accounts");
  await Native("DELETE FROM sales.w_serial");
  await Native("DELETE FROM sales.w_lines");
}

/** The stored text of a row's columns, as the database's own rendering shows them. */
async function Stored(id: string): Promise<Row> {
  const [row] = await Native<Row>(
    "SELECT big::text AS big, rating::text AS rating, seen::text AS seen, at::text AS at, raw::text AS raw, code, upper_code FROM sales.w_accounts WHERE id = $1",
    [id],
  );
  return row;
}

async function Seeded(code: string): Promise<string> {
  const [row] = await Native<{ id: string }>(
    `INSERT INTO sales.w_accounts (code, big, rating, seen, at, raw, tags)
     VALUES ($1, 9007199254740993, 0.1, '2026-01-01 10:00:00.123456', '2026-01-01 10:00:00.123456+00', '{"k":1,"k":2}', ARRAY['a'])
     RETURNING id::text AS id`,
    [code],
  );
  return row.id;
}

describe("inserting into an external relation", () => {
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("answers the database's generated keys in input order, each reading back its own row", async () => {
    const labels = Array.from({ length: 1000 }, (_, n) => `label-${999 - n}`);
    const ids = (await Table("w_serial").insert(
      labels.map((label) => ({ label })),
    )) as string[];
    expect(ids).to.have.length(1000);
    const rows = await Native<{ id: string; label: string }>(
      "SELECT id::text AS id, label FROM sales.w_serial",
    );
    const byId = new Map(rows.map((row) => [row.id, row.label]));
    expect(ids.map((id) => byId.get(id))).to.deep.equal(labels);
  });

  it("fills an omitted column with its DEFAULT and answers an identity key as _id", async () => {
    const [id] = (await Table("w_accounts").insert({ code: "d1" })) as string[];
    const row = (await Table("w_accounts").get(id)) as Row;
    expect(row).to.include({
      _id: id,
      id,
      code: "d1",
      status: "lead",
      upper_code: "D1",
    });
    expect(row.at).to.be.instanceOf(Date);
  });

  it("answers a key the database generates by default, and a list then shows the row under it", async () => {
    const [account] = (await Table("w_accounts").insert({
      code: "d2",
    })) as string[];
    const [sku] = (await Table("w_items").insert({
      account_id: account,
      qty: 3,
    })) as string[];
    expect(sku).to.match(/^[0-9a-f-]{36}$/);
    const listed = (await Table("w_items").filter((row) =>
      row.key("account_id").eq(account),
    )) as Row[];
    expect(listed.map((row) => row._id)).to.deep.equal([sku]);
  });

  it("writes a supplied composite _id into its key columns", async () => {
    const ids = await Table("w_lines").insert({ _id: '["7", "2"]', qty: 1 });
    expect(ids).to.deep.equal(['["7", "2"]']);
    expect(
      await NativeCount(
        "SELECT count(*) FROM sales.w_lines WHERE order_id = 7 AND line_no = 2",
      ),
    ).to.equal(1);
  });

  it("refuses an _id and a key field that disagree, writing nothing", async () => {
    const failure = await Failure(() =>
      Table("w_lines").insert({ _id: '["8", "1"]', order_id: 9, line_no: 1 }),
    );
    expect(failure.message).to.contain("order_id");
    expect(
      await NativeCount(
        "SELECT count(*) FROM sales.w_lines WHERE order_id IN (8, 9)",
      ),
    ).to.equal(0);
  });

  for (const [description, document, named] of [
    ["a value for an identity ALWAYS key", { id: "5", code: "x5" }, "identity"],
    [
      "a value for a generated column",
      { code: "x6", upper_code: "X" },
      "generated",
    ],
    ["a value for an array column", { code: "x7", tags: ["t"] }, "read-only"],
    ["an undeclared key", { code: "x8", nickname: "n" }, "nickname"],
    ["an _internal key", { code: "x9", _internal: {} }, "_internal"],
  ] as [string, Row, string][]) {
    it(`refuses ${description}, writing nothing`, async () => {
      const failure = await Failure(() =>
        Table("w_accounts").insert(document as never),
      );
      expect(failure.message).to.contain(named);
      expect(
        await NativeCount(
          "SELECT count(*) FROM sales.w_accounts WHERE code = $1",
          [document.code],
        ),
      ).to.equal(0);
    });
  }

  it("upserts on the key: update keeps an unmentioned column, replace clears it", async () => {
    await Table("w_lines").insert({ _id: '["20", "1"]', qty: 5 });
    await Table("w_lines").insert(
      { _id: '["20", "1"]' },
      { conflict: "update" },
    );
    expect(
      await NativeCount(
        "SELECT qty AS count FROM sales.w_lines WHERE order_id = 20",
      ),
    ).to.equal(5);
    await Table("w_lines").insert(
      { order_id: 20, line_no: 1 },
      { conflict: "replace" },
    );
    const [row] = await Native<{ qty: number | null }>(
      "SELECT qty FROM sales.w_lines WHERE order_id = 20",
    );
    expect(row.qty).to.equal(null);
  });
});

describe("values an external column cannot hold", () => {
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  for (const [table, document, field] of [
    ["w_accounts", { code: "v1", status: "archived" }, "status"],
    ["w_accounts", { code: "toolong" }, "code"],
    ["w_accounts", { code: "v2", revenue: 1e12 }, "revenue"],
    ["w_items", { sku: "nope", qty: 1 }, "sku"],
    ["w_serial", { id: 5.5, label: "v3" }, "id"],
    ["w_lines", { order_id: 1, line_no: 1, qty: 1.5 }, "qty"],
  ] as [string, Row, string][]) {
    it(`refuses ${JSON.stringify(document[field])} for ${table}.${field} before writing, naming the field`, async () => {
      const failure = await Failure(() =>
        Table(table).insert(document as never),
      );
      expect(failure.kind).to.equal("invalid");
      expect(failure.message).to.contain(`sales.${table}.${field}`);
      expect(await NativeCount(`SELECT count(*) FROM sales.${table}`)).to.equal(
        0,
      );
    });
  }
});

describe("writing back what was read from an external relation", () => {
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("changes no byte of what a lossy read cannot spell, and counts no changed row", async () => {
    const id = await Seeded("r1");
    const before = await Stored(id);
    const stored = (await Table("w_accounts").get(id)) as Row;
    expect(
      await Table("w_accounts")
        .get(id)
        .update(stored as never),
    ).to.equal(0);
    expect(await Stored(id)).to.deep.equal(before);
  });

  it("writes the one field an edit changed and keeps every other stored value", async () => {
    const id = await Seeded("r2");
    const before = await Stored(id);
    const stored = (await Table("w_accounts").get(id)) as Row;
    expect(
      await Table("w_accounts")
        .get(id)
        .update({ ...stored, code: "r2b" } as never),
    ).to.equal(1);
    expect(await Stored(id)).to.deep.equal({
      ...before,
      code: "r2b",
      upper_code: "R2B",
    });
  });

  it("writes nothing when _id or a key field names another row", async () => {
    const id = await Seeded("r3");
    const other = await Seeded("r4");
    expect(
      await Table("w_accounts").get(id).update({ _id: other, code: "zz" }),
    ).to.equal(0);
    expect(
      await Table("w_accounts").get(id).update({ id: other, code: "zz" }),
    ).to.equal(0);
    expect((await Stored(id)).code).to.equal("r3");
  });

  it("replaces: clears a silent field and leaves the generated column to the database", async () => {
    const id = await Seeded("r5");
    await Native("UPDATE sales.w_accounts SET email = 'a@b.c' WHERE id = $1", [
      id,
    ]);
    expect(await Table("w_accounts").get(id).replace({ code: "r5b" })).to.equal(
      1,
    );
    const [row] = await Native<Row>(
      "SELECT email, code, upper_code, status::text AS status FROM sales.w_accounts WHERE id = $1",
      [id],
    );
    expect(row).to.deep.equal({
      email: null,
      code: "r5b",
      upper_code: "R5B",
      status: "lead",
    });
  });
});

describe("selecting the rows an external write changes", () => {
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("updates rows selected by composite _id", async () => {
    await Table("w_lines").insert([
      { _id: '["30", "1"]', qty: 1 },
      { _id: '["30", "2"]', qty: 1 },
      { _id: '["30", "3"]', qty: 1 },
    ]);
    expect(
      await Table("w_lines")
        .getAll(['["30", "1"]', '["30", "3"]'])
        .update({ qty: 9 }),
    ).to.equal(2);
    expect(
      await NativeCount(
        "SELECT count(*) FROM sales.w_lines WHERE order_id = 30 AND qty = 9",
      ),
    ).to.equal(2);
  });

  it("deletes by _id and by filter, answering the count", async () => {
    const id = await Seeded("r6");
    await Seeded("r7");
    expect(await Table("w_accounts").get(id).delete()).to.equal(1);
    expect(
      await Table("w_accounts")
        .filter((row) => row.key("code").eq("r7"))
        .delete(),
    ).to.equal(1);
    expect(
      await NativeCount(
        "SELECT count(*) FROM sales.w_accounts WHERE code IN ('r6', 'r7')",
      ),
    ).to.equal(0);
  });

  it("targets an edit through the primary key index", async () => {
    const context = new DecodingContext({
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    });
    const root = BuildRoot(
      Table("w_accounts").get("1").update({ code: "p" }).build(),
      context,
    );
    const split = SplitWrite(root.rest);
    const relation = ApplyStages(root.relation, split.pipeline, context);
    const statement = CompileWrite(
      WriteTargetOf(root, relation),
      split.write!,
      context,
    );
    const client = await AcquireClient();
    try {
      await client.query("SET enable_seqscan = off");
      const plan = await client.query(
        `EXPLAIN ${statement.sql}`,
        context.params.all(),
      );
      expect(
        plan.rows.map((row: Row) => row["QUERY PLAN"]).join("\n"),
      ).to.contain("w_accounts_pkey");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });

  it("leaves a relation without a key unwritable, naming it", async () => {
    const failure = await Failure(() =>
      Table("raw_log")
        .filter((row) => row.key("msg").eq("r1"))
        .delete(),
    );
    expect(failure.message).to.contain('"sales"."raw_log"');
  });

  it("still refuses atomicMutation, naming the stage", async () => {
    const failure = await Failure(() =>
      Table("w_accounts").atomicMutation("1", {
        type: "update",
        revisionField: "code",
        expectedRevision: "a",
        nextRevision: "b",
        patch: {},
      }),
    );
    expect(failure.message).to.contain("atomicMutation");
  });
});

describe("what the database refuses on a write to an external relation", () => {
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("reports a duplicate value of a unique constraint", async () => {
    await Table("w_accounts").insert({ code: "e1" });
    const failure = await Failure(() =>
      Table("w_accounts").insert({ code: "e1" }),
    );
    expect(failure.kind).to.equal("duplicate");
    expect(failure.constraint).to.equal("w_accounts_code_key");
    expect(failure.message).to.contain("(code)=(e1)");
  });

  it("reports a missing required field, naming it", async () => {
    const failure = await Failure(() =>
      Table("w_items").insert({ qty: null } as never),
    );
    expect(failure.kind).to.equal("missing");
    expect(failure.fields).to.deep.equal(["qty"]);
  });

  it("reports a reference to a row that does not exist", async () => {
    const failure = await Failure(() =>
      Table("w_items").insert({ account_id: "999999", qty: 1 }),
    );
    expect(failure.kind).to.equal("reference");
  });

  it("reports deleting a row that is still referenced", async () => {
    const [account] = (await Table("w_accounts").insert({
      code: "e2",
    })) as string[];
    await Table("w_items").insert({ account_id: account, qty: 1 });
    const failure = await Failure(() =>
      Table("w_accounts").get(account).delete(),
    );
    expect(failure.kind).to.equal("referenced");
  });

  it("reports a broken check constraint", async () => {
    const failure = await Failure(() =>
      Table("w_accounts").insert({ code: "e3", revenue: -1 }),
    );
    expect(failure.kind).to.equal("check");
    expect(failure.constraint).to.equal("w_accounts_revenue_check");
  });
});
