import { expect } from "chai";
import {
  type Categories,
  Profile,
  type RelationProfile,
} from "@antelopejs/interface-database-catalog";

import type { RelationRow } from "../implementations/database/external-access";
import { SourceFor } from "../implementations/database/external-sample";
import { BIG_EVENTS_ROWS } from "./fixture";
import { Received } from "./received";
import { Native } from "./sales";

const CATEGORY_LIMIT = 25;
const CATEGORY_MIN_ROWS = 5;

interface ReferenceRow {
  value: string | number | boolean;
  rows: number;
}

/** The categories the profile answered before the fold moved into the query, from the same rows. */
async function Reference(
  expression: string,
  from: string,
  column: string,
): Promise<Categories> {
  const rows = await Native<ReferenceRow>(
    `SELECT ${expression} AS value, count(*)::float8 AS rows FROM ${from}
      WHERE r.${column} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${CATEGORY_LIMIT + 1}`,
  );
  return {
    values: rows.filter((row) => row.rows >= CATEGORY_MIN_ROWS),
    other: rows
      .filter((row) => row.rows < CATEGORY_MIN_ROWS)
      .reduce((total, row) => total + row.rows, 0),
  };
}

function CategoriesOf(profile: RelationProfile, column: string): Categories {
  const categories = profile.columns.find(
    (profiled) => profiled.name === column,
  )?.categories;
  expect(categories?.status, column).to.equal("ok");
  return categories?.status === "ok"
    ? categories.value
    : { values: [], other: 0 };
}

function Relation(name: string): RelationRow {
  return {
    oid: 0,
    schema: "sales",
    name,
    kind: "r",
    readable: true,
    someColumns: false,
    insert: false,
    update: false,
    delete: false,
    analyzed: false,
    statistics: null,
    liveTuples: null,
    comment: null,
  };
}

describe("the categories of an external column", function () {
  this.timeout(120_000);

  const columns = [
    { relation: "invoices", column: "kind", expression: "(r.kind)::text" },
    { relation: "accounts", column: "status", expression: "(r.status)::text" },
    { relation: "accounts", column: "active", expression: "r.active" },
    { relation: "order_lines", column: "qty", expression: "(r.qty)::float8" },
  ];
  for (const { relation, column, expression } of columns) {
    it(`answers ${relation}.${column} as it did when the fold ran in the driver`, async () => {
      const profile = await Profile({
        relation: `sales.${relation}`,
        columns: [column],
      });
      const expected = await Reference(
        expression,
        SourceFor(Relation(relation), null).from,
        column,
      );
      expect(JSON.stringify(CategoriesOf(profile, column))).to.equal(
        JSON.stringify(expected),
      );
    });
  }

  it("folds a value seen fewer than 5 times in the database, so no result set holds it", async () => {
    const { answer, results } = await Received(() =>
      Profile({ relation: "sales.invoices", columns: ["kind"] }),
    );
    expect(CategoriesOf(answer, "kind").other).to.equal(2);
    expect(results.join("\n")).to.include('"paid"');
    expect(results.join("\n")).to.not.include("disputed");
  });

  it("names a value seen 5 times and folds one seen 4 times in the database", async () => {
    const { answer, results } = await Received(() =>
      Profile({ relation: "sales.tallies", columns: ["label"] }),
    );
    expect(CategoriesOf(answer, "label")).to.deep.equal({
      values: [
        { value: "many", rows: 20 },
        { value: "five", rows: 5 },
      ],
      other: 4,
    });
    expect(results.join("\n")).to.include('"five"');
    expect(results.join("\n")).to.not.include("four");
  });

  it("folds a value seen fewer than 5 times in a sample in the database, as it did in the driver", async () => {
    const { answer, results } = await Received(() =>
      Profile({ relation: "sales.big_events", columns: ["kind"] }),
    );
    expect(answer.sample).to.not.equal(null);
    const categories = CategoriesOf(answer, "kind");
    expect(categories.other).to.be.above(0);
    const expected = await Reference(
      "(r.kind)::text",
      SourceFor(Relation("big_events"), BIG_EVENTS_ROWS).from,
      "kind",
    );
    expect(JSON.stringify(categories)).to.equal(JSON.stringify(expected));
    expect(results.join("\n")).to.include('"click"');
    expect(results.join("\n")).to.not.include("refund");
  });
});
