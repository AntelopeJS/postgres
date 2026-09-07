import { expect } from "chai";

import { ArrayOf, TEXT } from "../../implementations/database/types";
import {
  ApplySubqueries,
  FROM_TABLE,
  Occurrences,
  OTHER_TABLE,
  Other,
  PROFILES_TABLE,
  ProductDocument,
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

const PRODUCT_DOCUMENT = ProductDocument(NESTED_ALIAS);

const NESTED_INSTANCE = '("t1"."_instance" = ($1::text))';

const ONE_PRODUCT =
  `SELECT ${PRODUCT_DOCUMENT} AS "value" FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."_id" = ($2::text))`;

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

/**
 * The aggregate as the nested relation's own select list, which is where it is absorbed.
 *
 * `rows` is the relation with its projection replaced rather than a rendering wrapped in a second
 * select: the aggregate has to sit inside the relation for `jsonb_agg`'s own `ORDER BY` to name the
 * terms that relation carried, and a subquery's `ORDER BY` is not promised to survive into an outer
 * aggregate at all.
 */
function Aggregated(value: string, rest: string, order = ""): string {
  const collected = `COALESCE(jsonb_agg(${value}${order}), '[]'::jsonb)`;
  return `(SELECT ${collected} AS "value" ${rest})`;
}

const PRODUCTS_SOURCE =
  `FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."_id" IN (($2::text)))`;

const PRODUCTS_BY_NAME =
  `FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}"` +
  ` WHERE ${NESTED_INSTANCE} AND ("t1"."name" IN ("t0"."name"))`;

const ORDERED_PRODUCTS = `FROM ${OTHER_TABLE} AS "${NESTED_ALIAS}" WHERE ${NESTED_INSTANCE}`;

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
      Projecting(Aggregated(PRODUCT_DOCUMENT, PRODUCTS_SOURCE)),
    );
  });

  it("types the value as an array of what the nested query projects", () => {
    const { relation } = ApplySubqueries(
      Root().map(() => ProfilesRoot().getAll("k1").key("skills")),
    );
    expect(relation.projection?.type).to.deep.equal(ArrayOf(ArrayOf(TEXT)));
  });

  it("absorbs the aggregate rather than opening a select level over it", () => {
    const sql = SubquerySql(Root().map(() => Other().getAll("k1")));
    expect(sql).to.contain(`AS "${NESTED_ALIAS}"`);
    expect(sql).to.not.contain(`AS "${NEXT_ALIAS}"`);
    expect(sql).to.not.contain(`FROM (SELECT`);
  });

  it("carries the nested query's own ordering into the aggregate itself", () => {
    expect(SubquerySql(Root().map(() => Other().orderBy("name")))).to.equal(
      Projecting(
        Aggregated(
          PRODUCT_DOCUMENT,
          ORDERED_PRODUCTS,
          ` ORDER BY "${NESTED_ALIAS}"."name" ASC`,
        ),
      ),
    );
  });

  it("spells the ordering once, inside the aggregate rather than beside it", () => {
    const sql = SubquerySql(Root().map(() => Other().orderBy("name")));
    expect(Occurrences(sql, "ORDER BY")).to.equal(1);
    expect(sql).to.contain(`${PRODUCT_DOCUMENT} ORDER BY`);
  });

  it("wraps a stream whose rows were already chosen, and aggregates the wrap", () => {
    const sql = SubquerySql(Root().map(() => Other().slice(0, 2)));
    expect(sql).to.contain(`AS "${NEXT_ALIAS}"`);
    expect(sql).to.contain("LIMIT");
    expect(sql).to.contain(`jsonb_agg(${ProductDocument(NEXT_ALIAS)})`);
  });

  it("references every parameter it binds, ordering terms and bounds included", () => {
    const ledgers = [
      ReadParamLedger(
        ApplySubqueries(Root().map(() => Other().getAll("k1").orderBy("name"))),
      ),
      ReadParamLedger(ApplySubqueries(Root().map(() => Other().slice(0, 2)))),
    ];
    for (const ledger of ledgers) {
      expect(ledger.referenced).to.deep.equal(ledger.bound);
    }
  });

  it("wraps a distinct stream, whose dedup the aggregate would otherwise erase", () => {
    const sql = SubquerySql(Root().map(() => Other().distinct()));
    expect(sql).to.contain("SELECT DISTINCT");
    expect(sql).to.contain(`jsonb_agg(${ProductDocument(NEXT_ALIAS)})`);
  });
});

describe("a subquery correlated to the query containing it", () => {
  it("spells the outer relation's own alias inside the nested select", () => {
    expect(
      SubquerySql(Root().map((doc) => Other().getAll(doc.key("name"), "name"))),
    ).to.equal(Projecting(Aggregated(PRODUCT_DOCUMENT, PRODUCTS_BY_NAME)));
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

/**
 * A grouped query is `aggregated` and **not** `single`, which is the pair that reaches this branch.
 *
 * `stages-aggregate.ts:SetAggregate` sets both, so a stream aggregate takes the single-row branch
 * and never gets here — which was the whole argument for leaving `aggregated` out of
 * `SUBQUERY_BLOCKERS`, and `group` is what ended it. Unwrapped, the `jsonb_agg` absorbs into a
 * relation that already carries a `GROUP BY` and an aggregate in its select list: `42803 aggregate
 * function calls cannot be nested`, at execution, losing the whole statement.
 */
describe("a grouped query used as a value", () => {
  function CountedByName(): string {
    return SubquerySql(
      Root().map(() => Other().group("name", (stream) => stream.count())),
    );
  }

  it("wraps the group instead of aggregating into it", () => {
    const sql = CountedByName();
    expect(Occurrences(sql, "GROUP BY")).to.equal(1);
    expect(sql).to.contain("FROM (SELECT");
    expect(sql).to.contain(`AS "${NEXT_ALIAS}"`);
  });

  it("puts no aggregate inside another, which is the 42803 the blocker prevents", () => {
    const sql = CountedByName();
    const outer = sql.slice(0, sql.indexOf("FROM (SELECT"));
    expect(outer).to.contain("jsonb_agg(");
    expect(outer).to.not.contain("count(");
  });

  it("wraps a mapper that does not aggregate either, which would be 21000", () => {
    const sql = SubquerySql(
      Root().map(() => Other().group("name", (_stream, group) => group)),
    );
    expect(sql).to.contain("FROM (SELECT");
    expect(sql.indexOf("jsonb_agg(")).to.be.lessThan(sql.indexOf("GROUP BY"));
  });

  it("binds every parameter it references, the wrap notwithstanding", () => {
    const ledger = ReadParamLedger(
      ApplySubqueries(
        Root().map(() => Other().group("name", (stream) => stream.count())),
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
