import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";
import { Query } from "@antelopejs/interface-database/query";
import { expect } from "chai";
import { ID_COLUMN } from "../../implementations/database/utils";
import {
  Apply,
  FROM_TABLE,
  Occurrences,
  OTHER_TABLE,
  Other,
  type Product,
  ReadParamLedger,
  ROOT_ALIAS,
  Root,
  Sql,
  TABLE,
  Write,
} from "./pipeline-fixture";

/** The alias the right query's own root claims, the left having already spent the root one. */
const RIGHT_ALIAS = "t1";

/** The alias the right becomes addressable at once it is a FROM item of the left. */
const JOIN_ALIAS = "t2";

const DELETE_STAGE = "delete";

const MATCHED_NAME = "widget";

const SLICE_OFFSET = 0;
const SLICE_COUNT = 2;

const WRAP_ALIAS = "t1";
const WRAPPED_JOIN_ALIAS = "t3";
const SECOND_WRAP_ALIAS = "t3";
const SECOND_JOIN_ALIAS = "t5";

/**
 * The physical select list a row-mode products relation renders, at the given alias.
 *
 * Transcribed rather than derived, exactly as the fixture's people sibling is: a spec that asked
 * the renderer for its own expected value would assert only that the renderer is deterministic.
 */
function ProductColumns(alias: string): string {
  return (
    `"${alias}"."_id", "${alias}"."_instance", "${alias}"."name",` +
    ` "${alias}"."price", "${alias}"."_extra"`
  );
}

/** The document `ColumnRowSource.toJson` builds over the products table, at the given alias. */
function ProductDocument(alias: string): string {
  return (
    `(jsonb_strip_nulls(jsonb_build_object('_id', "${alias}"."_id",` +
    ` 'name', "${alias}"."name", 'price', "${alias}"."price"))` +
    ` || COALESCE("${alias}"."_extra", '{}'::jsonb))`
  );
}

const RIGHT_ROWS =
  `(SELECT ${ProductColumns(RIGHT_ALIAS)} FROM ${OTHER_TABLE} AS "${RIGHT_ALIAS}"` +
  ` WHERE ("${RIGHT_ALIAS}"."_instance" = ($1::text)))`;

const MATCHING_NAMES = `(("${ROOT_ALIAS}"."name" = "${JOIN_ALIAS}"."name"))`;

const RIGHT_PRICE = `"${JOIN_ALIAS}"."price"`;

const INNER_JOIN = "JOIN";
const LEFT_JOIN = "LEFT JOIN";

function Joined(kind: string, projection: string): string {
  return (
    `SELECT ${projection} AS "value" ${FROM_TABLE}` +
    ` ${kind} ${RIGHT_ROWS} AS "${JOIN_ALIAS}" ON ${MATCHING_NAMES}`
  );
}

function InnerPrice() {
  return Root().joinInner(
    Other(),
    (left, right) => left.key("name").eq(right.key("name")),
    (_left, right) => right.cast<Product>().key("price"),
  );
}

function LeftPrice() {
  return Root().join(
    Other(),
    (left, right) => left.key("name").eq(right.key("name")),
    (_left, right) => right.cast<Product>().key("price"),
  );
}

function InnerDocument() {
  return Root().joinInner(
    Other(),
    (left, right) => left.key("name").eq(right.key("name")),
    (_left, right) => right,
  );
}

function LeftDocument() {
  return Root().join(
    Other(),
    (left, right) => left.key("name").eq(right.key("name")),
    (_left, right) => right,
  );
}

/**
 * A right whose own pipeline projected a value, so it reaches the join in value mode.
 *
 * The one shape where a left join's right parameter must be left *unguarded*: its `toJson` is
 * already the joined column, which a missed row leaves SQL NULL on its own. Guarding it instead
 * would spell `-> '_id'` against a projected scalar, which is NULL for every row matched or not —
 * no error, no failing type, and the mapper's right reading `null` on all of them.
 */
function LeftValueRight() {
  return Root().join(
    Other().map((doc) => doc.key("name")),
    (left, right) => left.key("name").eq(right),
    (_left, right) => right,
  );
}

function Sliced() {
  return Root()
    .slice(SLICE_OFFSET, SLICE_COUNT)
    .joinInner(
      Other(),
      (left, right) => left.key("name").eq(right.key("name")),
      (_left, right) => right.cast<Product>().key("price"),
    );
}

function Ordered() {
  return Root()
    .orderBy("name")
    .joinInner(
      Other(),
      (left, right) => left.key("name").eq(right.key("name")),
      (_left, right) => right.cast<Product>().key("price"),
    );
}

function Mapped() {
  return Root()
    .map((doc) => ({ label: doc.key("name") }))
    .joinInner(
      Other(),
      (left, right) => left.key("label").eq(right.key("name")),
      (_left, right) => right.cast<Product>().key("price"),
    );
}

/** A left that bound a parameter of its own before the right's root bound one. */
function Filtered() {
  return Root()
    .filter((doc) => doc.key("name").eq(MATCHED_NAME))
    .joinInner(
      Other(),
      (left, right) => left.key("name").eq(right.key("name")),
      (_left, right) => right.cast<Product>().key("price"),
    );
}

function Chained() {
  return InnerPrice().joinInner(
    Other(),
    (left, right) => left.eq(right.key("price")),
    (_left, right) => right.cast<Product>().key("name"),
  );
}

/**
 * A `delete` behind a join, recorded the way the contract records one.
 *
 * A join yields a stream the contract gives no `delete` to, so the stage is appended rather than
 * chained — the refusal is the compiler's rather than the type system's.
 */
function Deleting(): StagedObject {
  return new Query<number>(QueryStage(DELETE_STAGE), InnerPrice());
}

describe("the join stage", () => {
  it("joins the nested right query under the inner join keyword", () => {
    expect(Sql(InnerPrice())).to.equal(Joined(INNER_JOIN, RIGHT_PRICE));
  });

  it("joins under the left join keyword when a missed row must survive", () => {
    expect(Sql(LeftPrice())).to.equal(Joined(LEFT_JOIN, RIGHT_PRICE));
  });

  it("compiles the right side's own root, instance predicate and parameter", () => {
    const { context } = Apply(InnerPrice());
    expect(Sql(InnerPrice())).to.contain(
      `("${RIGHT_ALIAS}"."_instance" = ($1::text))`,
    );
    expect(context.params.all()).to.deep.equal([""]);
    expect(Sql(Filtered())).to.contain(
      `("${RIGHT_ALIAS}"."_instance" = ($2::text))`,
    );
    expect(Apply(Filtered()).context.params.all()).to.deep.equal([
      MATCHED_NAME,
      "",
    ]);
  });

  it("compiles the ON from two bare qualified columns", () => {
    const { relation } = Apply(InnerPrice());
    expect(relation.joins.map((join) => join.on)).to.deep.equal([
      MATCHING_NAMES,
    ]);
  });

  it("materializes neither side of the ON into a document", () => {
    const { relation } = Apply(InnerDocument());
    expect(relation.joins[0].on).to.not.contain("jsonb_build_object");
  });

  it("reads the right query directly rather than as a correlated subquery", () => {
    expect(Apply(InnerPrice()).subqueries).to.equal(0);
  });

  it("leaves value mode with the mapper's result as the projection", () => {
    const { relation } = Apply(InnerPrice());
    expect(relation.projection?.sql).to.equal(RIGHT_PRICE);
    expect(relation.origin).to.equal(undefined);
  });

  it("refuses a write after it, the relation no longer knowing a table", () => {
    expect(() => Write(Deleting())).to.throw(
      "A row-mode relation must carry the origin of its table",
    );
  });
});

describe("the mapper's right parameter", () => {
  it("materializes an inner join's right row with no guard at all", () => {
    expect(Sql(InnerDocument())).to.equal(
      Joined(INNER_JOIN, ProductDocument(JOIN_ALIAS)),
    );
  });

  it("guards a left join's whole right document on the key column", () => {
    const guarded =
      `(CASE WHEN "${JOIN_ALIAS}"."_id" IS NOT NULL` +
      ` THEN ${ProductDocument(JOIN_ALIAS)} END)`;
    expect(Sql(LeftDocument())).to.equal(Joined(LEFT_JOIN, guarded));
  });

  it("reads one field of a left join's right row as a bare column", () => {
    const sql = Sql(LeftPrice());
    expect(sql).to.contain(`SELECT ${RIGHT_PRICE} AS "value"`);
    expect(sql).to.not.contain("CASE");
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("leaves a value-mode right unguarded, its projected column being null already", () => {
    const sql = Sql(LeftValueRight());
    expect(sql).to.contain(
      `SELECT to_jsonb("${JOIN_ALIAS}"."value") AS "value" FROM`,
    );
    expect(sql).to.not.contain(ID_COLUMN);
  });
});

describe("a join over a relation that has already chosen its rows", () => {
  it("wraps a relation whose row bounds are decided", () => {
    const { relation } = Apply(Sliced());
    expect(relation.alias).to.equal(WRAP_ALIAS);
    expect(relation.from).to.contain("LIMIT");
    expect(relation.joins.map((join) => join.alias)).to.deep.equal([
      WRAPPED_JOIN_ALIAS,
    ]);
  });

  it("keeps an ordering on the outer relation rather than wrapping it", () => {
    const { relation } = Apply(Ordered());
    expect(relation.from).to.equal(TABLE);
    expect(relation.alias).to.equal(ROOT_ALIAS);
    expect(Sql(Ordered())).to.equal(
      `${Joined(INNER_JOIN, RIGHT_PRICE)} ORDER BY "${ROOT_ALIAS}"."name" ASC`,
    );
  });

  it("wraps a relation a map already projected, and reads its value column", () => {
    const sql = Sql(Mapped());
    expect(sql).to.contain(`"${WRAP_ALIAS}"."value" -> 'label'`);
    expect(Occurrences(sql, `AS "${WRAP_ALIAS}"`)).to.equal(1);
  });

  it("chains, the second join reading the first's projected column", () => {
    const { relation } = Apply(Chained());
    expect(relation.alias).to.equal(SECOND_WRAP_ALIAS);
    expect(relation.from).to.contain(`AS "${JOIN_ALIAS}" ON`);
    expect(relation.joins.map((join) => join.alias)).to.deep.equal([
      SECOND_JOIN_ALIAS,
    ]);
    expect(relation.joins[0].on).to.contain(`"${SECOND_WRAP_ALIAS}"."value"`);
  });
});

describe("the join stage's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    const ledger = ReadParamLedger(Apply(Chained()));
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });
});
