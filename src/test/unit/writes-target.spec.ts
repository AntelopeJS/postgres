import { expect } from "chai";
import { Query } from "@antelopejs/interface-database/query";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";

import {
  CrossInstanceRoot,
  EVERY_ROW,
  expectBalancedLedger,
  FROM_TABLE,
  IdentityPredicate,
  Occurrences,
  PeopleColumns,
  ROOT_ALIAS,
  ROW_COLUMNS,
  Root,
  WrittenSql as Sql,
  TABLE,
  Write,
  type Written,
} from "./pipeline-fixture";

const DELETE_FROM = `DELETE FROM ${TABLE} AS "w0"`;
const INSTANCE_PREDICATE = '"_instance" = ';
const DELETE_STAGE = "delete";
const KEY = "k";
const NAME = "a";

const WRAP_ALIAS = "t1";
const NESTED_ALIAS = "t2";
const KEY_ARITY = 2;
const NESTING_LEVELS = 3;

const SLICE_OFFSET = 2;
const SLICE_COUNT = 5;
const MINIMUM_AGE = 18;
const SLICE_OFFSET_PARAM = 3;
const SLICE_COUNT_PARAM = 4;
const NAME_PARAM = 5;

const SORTED_OFFSET = 0;
const SORTED_COUNT = 3;
const SORTED_OFFSET_PARAM = 2;
const SORTED_COUNT_PARAM = 3;

const INT4_MAX = 2147483647;

/**
 * The whole statement, given the one rendering of the relation its identity target wraps.
 *
 * The wrap's alias is a parameter because it is whatever the alias counter had left after the
 * pipeline ran — a relation the pipeline itself wrapped has already spent one.
 */
function Deletes(rendered: string, alias?: string): string {
  return `${DELETE_FROM} WHERE ${IdentityPredicate(rendered, alias)}`;
}

/** The clamp a caller-supplied row bound compiles to, at the position the stage bound it. */
function Bound(position: number): string {
  return (
    `((CASE WHEN ($${position}::double precision) IS NOT NULL THEN` +
    ` LEAST(GREATEST(trunc(($${position}::double precision)), 0), ${INT4_MAX}) END)::bigint)`
  );
}

const SLICED =
  `SELECT ${ROW_COLUMNS} ${FROM_TABLE}` +
  ` WHERE ("${ROOT_ALIAS}"."_instance" = ($1::text))` +
  ` AND (("${ROOT_ALIAS}"."age" >= ($2::double precision)))` +
  ` LIMIT ${Bound(SLICE_COUNT_PARAM)} OFFSET ${Bound(SLICE_OFFSET_PARAM)}`;

function Sliced(): Written {
  return Write(
    Root()
      .filter((doc) => doc.key("age").ge(MINIMUM_AGE))
      .slice(SLICE_OFFSET, SLICE_COUNT)
      .delete(),
  );
}

/** The same slice read a second time, which is the one query the pipeline has to wrap. */
function Wrapped(): Written {
  return Write(
    Root()
      .filter((doc) => doc.key("age").ge(MINIMUM_AGE))
      .slice(SLICE_OFFSET, SLICE_COUNT)
      .filter((doc) => doc.key("name").eq(NAME))
      .delete(),
  );
}

/**
 * A `delete` behind a stage that reshaped the rows, recorded the way the contract records one.
 *
 * `map` yields a stream the contract gives no `delete` to, so the stage is appended rather than
 * chained — the refusal is the compiler's rather than the type system's, and only a query the
 * types cannot spell reaches it.
 */
function Reshaped(): StagedObject {
  return new Query<number>(
    QueryStage(DELETE_STAGE),
    Root().map((doc) => doc.key("name")),
  );
}

describe("the delete statement", () => {
  it("wraps the base relation, instance predicate and all", () => {
    expect(Sql(Write(Root().delete()))).to.equal(Deletes(EVERY_ROW));
  });

  it("answers a count rather than a list of keys", () => {
    expect(Write(Root().delete()).statement.ids).to.equal(undefined);
  });

  it("carries a slice's row bounds into the subselect rather than dropping them", () => {
    expect(Sql(Sliced())).to.equal(Deletes(SLICED));
  });

  it("keeps the ordering the row bounds were taken against", () => {
    const written = Write(
      Root().orderBy("age", "desc").slice(SORTED_OFFSET, SORTED_COUNT).delete(),
    );
    expect(Sql(written)).to.equal(
      Deletes(
        `SELECT ${ROW_COLUMNS} ${FROM_TABLE}` +
          ` WHERE ("${ROOT_ALIAS}"."_instance" = ($1::text))` +
          ` ORDER BY "${ROOT_ALIAS}"."age" DESC` +
          ` LIMIT ${Bound(SORTED_COUNT_PARAM)} OFFSET ${Bound(SORTED_OFFSET_PARAM)}`,
      ),
    );
  });

  it("projects two columns out of a wrapped relation that renders eight", () => {
    const written = Wrapped();
    expect(Sql(written)).to.equal(
      Deletes(
        `SELECT ${PeopleColumns(WRAP_ALIAS)} FROM (${SLICED}) AS "${WRAP_ALIAS}"` +
          ` WHERE (("${WRAP_ALIAS}"."name" = ($${NAME_PARAM}::text)))`,
        NESTED_ALIAS,
      ),
    );
    expect(Occurrences(Sql(written), `"${NESTED_ALIAS}"."`)).to.equal(
      KEY_ARITY,
    );
  });

  it("targets the one row a get selected", () => {
    const written = Write(Root().get(KEY).delete());
    expect(Sql(written)).to.contain(`("${ROOT_ALIAS}"."_id" = ($2::text))`);
    expect(written.context.params.all()).to.deep.equal(["", KEY]);
  });

  it("renders the relation exactly once, however deep the pipeline wrapped it", () => {
    const written = Wrapped();
    expect(Occurrences(Sql(written), FROM_TABLE)).to.equal(1);
    expect(Occurrences(Sql(written), "SELECT")).to.equal(NESTING_LEVELS);
  });

  it("refuses a relation that no longer knows its table, naming what is missing", () => {
    expect(() => Write(Reshaped())).to.throw(
      "A row-mode relation must carry the origin of its table",
    );
  });
});

describe("delete under CROSS_INSTANCE", () => {
  it("removes the rows of every instance, predicating on none of them", () => {
    const written = Write(CrossInstanceRoot().delete());
    expect(Sql(written)).to.equal(
      Deletes(`SELECT ${ROW_COLUMNS} ${FROM_TABLE}`),
    );
    expect(Sql(written)).to.not.contain(INSTANCE_PREDICATE);
    expect(written.context.params.all()).to.deep.equal([]);
  });

  /**
   * `_id` is unique per instance, so reading every instance at once makes the primary key name one
   * row per instance holding it. Without the bound a `SingleSelection` removed all of them.
   */
  it("removes one row through a get, which is what a SingleSelection selects", () => {
    const sql = Sql(Write(CrossInstanceRoot().get(KEY).delete()));
    expect(sql).to.contain(`ORDER BY "${ROOT_ALIAS}"."_instance" ASC`);
    expect(sql).to.contain("LIMIT");
  });

  it("bounds no get that already names one instance, which needs no order at all", () => {
    expect(Sql(Write(Root().get(KEY).delete()))).to.not.contain("ORDER BY");
  });
});

describe("the delete statement's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    expectBalancedLedger([
      Write(Root().delete()),
      Write(CrossInstanceRoot().delete()),
      Write(Root().get(KEY).delete()),
      Sliced(),
      Wrapped(),
    ]);
  });
});
