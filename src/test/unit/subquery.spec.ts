import { expect } from "chai";
import { ArrayOf, TEXT } from "../../implementations/database/types";
import {
  ApplySubqueries,
  FROM_TABLE,
  OTHER_TABLE,
  Other,
  PROFILES_TABLE,
  ProfilesRoot,
  ReadParamLedger,
  Root,
  SubquerySql,
} from "./pipeline-fixture";

/** The alias a nested root claims, the outer relation having already spent the root one. */
const NESTED_ALIAS = "t1";

/** The one after it from the same counter — an aggregation's wrap, or a second nested root. */
const NEXT_ALIAS = "t2";

/** The one after *that*, which nothing in these specs opens and none of them may spell. */
const UNCLAIMED_ALIAS = "t3";

const PRODUCT_DOCUMENT =
  `(jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", 'name', "t1"."name",` +
  ` 'price', "t1"."price")) || COALESCE("t1"."_extra", '{}'::jsonb))`;

const NESTED_INSTANCE = '("t1"."_instance" = ($1::text))';

const ONE_PRODUCT =
  `SELECT ${PRODUCT_DOCUMENT} AS "value" FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."_id" = ($2::text))`;

const PRODUCTS_BY_KEY =
  `SELECT ${PRODUCT_DOCUMENT} AS "value" FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."_id" IN (($2::text)))`;

const CORRELATED_PRODUCTS =
  `SELECT ${PRODUCT_DOCUMENT} AS "value" FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."name" IN ("t0"."name"))`;

const ONE_PROFILE_SKILL =
  `SELECT "t1"."skills" AS "value" FROM ${PROFILES_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."_id" = ($2::text))`;

/**
 * The head of the physical select list a row-mode relation renders.
 *
 * The assertion is its **absence**: a relation rendered with its physical columns is a hard
 * `42601 subquery must return only one column`, and that is what a row-mode nested query is until
 * its projection is set.
 */
const PHYSICAL_COLUMNS = '"t1"."_id", "t1"."_instance"';

function Aggregated(rows: string): string {
  return (
    `(SELECT COALESCE(jsonb_agg("${NEXT_ALIAS}"."value"), '[]'::jsonb)` +
    ` FROM (${rows}) AS "${NEXT_ALIAS}")`
  );
}

function Projecting(value: string): string {
  return `SELECT ${value} AS "value" ${FROM_TABLE}`;
}

describe("a single-row query used as a value", () => {
  it("compiles to one parenthesised select of the materialized document", () => {
    expect(SubquerySql(Root().map(() => Other().get("k1")))).to.equal(
      Projecting(`(${ONE_PRODUCT})`),
    );
  });

  it("never carries the physical column list a row-mode relation renders", () => {
    expect(SubquerySql(Root().map(() => Other().get("k1")))).to.not.contain(
      PHYSICAL_COLUMNS,
    );
  });

  it("reaches the correlated-subquery compiler rather than a stage handler", () => {
    expect(
      ApplySubqueries(Root().map(() => Other().get("k1"))).subqueries,
    ).to.equal(1);
  });

  it("keeps the projection of a nested query that already had one", () => {
    expect(
      SubquerySql(Root().map(() => ProfilesRoot().get("k1").key("skills"))),
    ).to.equal(Projecting(`(${ONE_PROFILE_SKILL})`));
  });

  it("materializes no document for a nested query that projects a field", () => {
    expect(
      SubquerySql(Root().map(() => ProfilesRoot().get("k1").key("skills"))),
    ).to.not.contain("jsonb_build_object");
  });

  it("carries the projection's own declared type, array and all", () => {
    const { relation } = ApplySubqueries(
      Root().map(() => ProfilesRoot().get("k1").key("skills")),
    );
    expect(relation.projection?.type).to.deep.equal(ArrayOf(TEXT));
  });
});

describe("a stream query used as a value", () => {
  it("aggregates its rows into a jsonb array, empty rather than null", () => {
    expect(SubquerySql(Root().map(() => Other().getAll("k1")))).to.equal(
      Projecting(Aggregated(PRODUCTS_BY_KEY)),
    );
  });

  it("types the value as an array of what the nested query projects", () => {
    const { relation } = ApplySubqueries(
      Root().map(() => ProfilesRoot().getAll("k1").key("skills")),
    );
    expect(relation.projection?.type).to.deep.equal(ArrayOf(ArrayOf(TEXT)));
  });

  it("opens its own alias after the one the nested root claimed", () => {
    const sql = SubquerySql(Root().map(() => Other().getAll("k1")));
    expect(sql).to.contain(`AS "${NESTED_ALIAS}"`);
    expect(sql).to.contain(`AS "${NEXT_ALIAS}"`);
  });
});

describe("a subquery correlated to the query containing it", () => {
  it("spells the outer relation's own alias inside the nested select", () => {
    expect(
      SubquerySql(Root().map((doc) => Other().getAll(doc.key("name"), "name"))),
    ).to.equal(Projecting(Aggregated(CORRELATED_PRODUCTS)));
  });

  it("binds two subqueries in one document to distinct parameters", () => {
    const { context } = ApplySubqueries(
      Root().map(() => ({
        first: Other().get("k1"),
        second: Other().get("k2"),
      })),
    );
    expect(context.params.all()).to.deep.equal(["", "k1", "", "k2"]);
  });

  it("gives two subqueries in one document distinct aliases", () => {
    const sql = SubquerySql(
      Root().map(() => ({
        first: Other().get("k1"),
        second: Other().get("k2"),
      })),
    );
    expect(sql).to.contain(`AS "${NESTED_ALIAS}"`);
    expect(sql).to.contain(`AS "${NEXT_ALIAS}"`);
    expect(sql).to.not.contain(`AS "${UNCLAIMED_ALIAS}"`);
  });

  it("references every parameter it binds, and binds every one it references", () => {
    const ledger = ReadParamLedger(
      ApplySubqueries(
        Root().map(() => ({
          first: Other().get("k1"),
          second: Other().getAll("k2"),
        })),
      ),
    );
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });
});

describe("a write nested inside another query", () => {
  it("is refused by a message naming the stage rather than the value", () => {
    expect(() =>
      ApplySubqueries(Root().map(() => Other().insert({ name: "widget" }))),
    ).to.throw(/'insert' stage writes/);
  });

  it("is refused wherever in the nested pipeline it appears", () => {
    expect(() =>
      ApplySubqueries(Root().map(() => Other().get("k1").delete())),
    ).to.throw(/'delete' stage writes/);
  });
});
