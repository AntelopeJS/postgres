import { expect } from "chai";
import {
  Apply,
  DOCUMENT,
  FROM_TABLE,
  NewProfiles,
  Occurrences,
  OTHER_TABLE,
  Other,
  PROFILES_TABLE,
  ProfilesRoot,
  ReadParamLedger,
  ROOT_ALIAS,
  Root,
  Sql,
  TABLE,
} from "./pipeline-fixture";

/** The alias the looked-up query's own root claims, the left having already spent the root one. */
const RIGHT_ALIAS = "t1";

/** The alias the lateral becomes addressable at, which is the key's replacement value. */
const LATERAL_ALIAS = "t2";

const COLLECTED_ALIAS = "t2";
const COLLECTED_LATERAL_ALIAS = "t3";

const WRAP_ALIAS = "t1";
const WRAPPED_LATERAL_ALIAS = "t3";

const CHAINED_WRAP_ALIAS = "t3";
const CHAINED_LATERAL_ALIAS = "t5";

const FILTER_WRAP_ALIAS = "t3";

/** The aliases a lookup over a left with no shape spends, the guard claiming the last of them. */
const OPAQUE_WRAP_ALIAS = "t1";
const OPAQUE_RIGHT_ALIAS = "t2";
const OPAQUE_LATERAL_ALIAS = "t3";
const OPAQUE_HELD_ALIAS = "t4";

const SLICE_OFFSET = 0;
const SLICE_COUNT = 2;
const MINIMUM_AGE = 25;

const LATERAL = "LEFT JOIN LATERAL";
const ON_TRUE = "ON true";
const ONE_ROW = "LIMIT ((1)::bigint)";
const HELD_COLUMN = "looked";

/** The document `ColumnRowSource.toJson` builds over the products table, at the given alias. */
function ProductDocument(alias: string): string {
  return (
    `(jsonb_strip_nulls(jsonb_build_object('_id', "${alias}"."_id",` +
    ` 'name', "${alias}"."name", 'price', "${alias}"."price"))` +
    ` || COALESCE("${alias}"."_extra", '{}'::jsonb))`
  );
}

/**
 * The document the profiles table materializes, at the given alias.
 *
 * Transcribed rather than derived, exactly as the fixture's people sibling is. It is the one shape
 * here whose declared field is jsonb-backed, so it carries a container member beside the stripped
 * scalars.
 */
function ProfileDocument(alias: string): string {
  return (
    `(jsonb_strip_nulls(jsonb_build_object('_id', "${alias}"."_id",` +
    ` 'name', "${alias}"."name"))` +
    ` || (CASE WHEN "${alias}"."skills" IS NULL THEN '{}'::jsonb` +
    ` ELSE jsonb_build_object('skills', "${alias}"."skills") END)` +
    ` || COALESCE("${alias}"."_extra", '{}'::jsonb))`
  );
}

function RightInstance(alias: string): string {
  return `("${alias}"."_instance" = ($1::text))`;
}

const RIGHT_INSTANCE = RightInstance(RIGHT_ALIAS);

const MATCHING_NAME = `("${RIGHT_ALIAS}"."name" = "${ROOT_ALIAS}"."name")`;

const MEMBER_NAME = `("${ROOT_ALIAS}"."skills" @> to_jsonb("${RIGHT_ALIAS}"."name"))`;

const ONE_PRODUCT =
  `(SELECT ${ProductDocument(RIGHT_ALIAS)} AS "value"` +
  ` FROM ${OTHER_TABLE} AS "${RIGHT_ALIAS}"` +
  ` WHERE ${RIGHT_INSTANCE} AND ${MATCHING_NAME} ${ONE_ROW})`;

const MATCHED_PRODUCTS =
  `(SELECT ${ProductDocument(RIGHT_ALIAS)} AS "value"` +
  ` FROM ${OTHER_TABLE} AS "${RIGHT_ALIAS}"` +
  ` WHERE ${RIGHT_INSTANCE} AND ${MEMBER_NAME})`;

const ALL_PRODUCTS =
  `(SELECT COALESCE(jsonb_agg("${COLLECTED_ALIAS}"."value"), '[]'::jsonb) AS "value"` +
  ` FROM ${MATCHED_PRODUCTS} AS "${COLLECTED_ALIAS}")`;

function Member(key: string, lateral: string): string {
  return `jsonb_build_object('${key}', "${lateral}"."value")`;
}

/** The bare merge a left document whose type carries a shape is replaced through. */
function Merged(document: string, key: string, lateral: string): string {
  return `(${document} || ${Member(key, lateral)})`;
}

/** The same merge under the container guard, which only a left with no shape is emitted with. */
function GuardedMerge(
  document: string,
  key: string,
  lateral: string,
  alias: string,
): string {
  const held = `"${alias}"."${HELD_COLUMN}"`;
  return (
    `(SELECT ${held} || ${Member(key, lateral)}` +
    ` FROM (SELECT ${document} AS "${HELD_COLUMN}") AS "${alias}"` +
    ` WHERE jsonb_typeof(${held}) = 'object')`
  );
}

const OPAQUE_LEFT = `"${OPAQUE_WRAP_ALIAS}"."value"`;

const OPAQUE_SOURCE = `(SELECT "${ROOT_ALIAS}"."meta" AS "value" ${FROM_TABLE})`;

const OPAQUE_KEY = `(${OPAQUE_LEFT} -> 'name')`;

const OPAQUE_NAME =
  `(CASE WHEN jsonb_typeof(${OPAQUE_KEY}) = 'string'` +
  ` THEN (${OPAQUE_KEY} #>> '{}') END)`;

const ONE_PRODUCT_BY_OPAQUE_NAME =
  `(SELECT ${ProductDocument(OPAQUE_RIGHT_ALIAS)} AS "value"` +
  ` FROM ${OTHER_TABLE} AS "${OPAQUE_RIGHT_ALIAS}"` +
  ` WHERE ${RightInstance(OPAQUE_RIGHT_ALIAS)}` +
  ` AND ("${OPAQUE_RIGHT_ALIAS}"."name" = ${OPAQUE_NAME}) ${ONE_ROW})`;

function ScalarLookup() {
  return Root().lookup(Other(), "name", "name");
}

/**
 * A lookup whose left is a declared jsonb column, which is where the type carries no shape.
 *
 * `meta` is declared as the bottom json type, so the projection a `map` onto it leaves is opaque
 * and nothing this compiler built says the value is an object.
 */
function OpaqueLookup() {
  return Root()
    .map((doc) => doc.key("meta"))
    .lookup(Other(), "name", "name");
}

function ArrayLookup() {
  return ProfilesRoot().lookup(Other(), "skills", "name");
}

function LookupOnGet() {
  return Root().get("k1").lookup(Other(), "name", "name");
}

function ChainedLookup() {
  return ScalarLookup().lookup(Other(), "age", "name");
}

function SlicedLookup() {
  return Root()
    .slice(SLICE_OFFSET, SLICE_COUNT)
    .lookup(Other(), "name", "name");
}

function MappedLookup() {
  return Root()
    .map((doc) => ({ label: doc.key("name") }))
    .lookup(Other(), "label", "name");
}

function FilteredLookup() {
  return ScalarLookup().filter((doc) => doc.key("age").gt(MINIMUM_AGE));
}

describe("the lookup stage", () => {
  it("replaces the local key from a one-row lateral over the other query", () => {
    expect(Sql(ScalarLookup())).to.equal(
      `SELECT ${Merged(DOCUMENT, "name", LATERAL_ALIAS)}` +
        ` AS "value" ${FROM_TABLE}` +
        ` ${LATERAL} ${ONE_PRODUCT} AS "${LATERAL_ALIAS}" ${ON_TRUE}`,
    );
  });

  it("carries the other query's own instance predicate into the lateral", () => {
    const { relation, context } = Apply(ScalarLookup());
    expect(relation.joins[0].from).to.contain(RIGHT_INSTANCE);
    expect(context.params.all()).to.deep.equal([""]);
  });

  it("bounds the lateral to one row, so it cannot multiply the left", () => {
    const { relation } = Apply(ScalarLookup());
    expect(relation.joins.map((join) => join.kind)).to.deep.equal([LATERAL]);
    expect(relation.joins[0].on).to.equal("true");
    expect(relation.joins[0].from).to.contain(ONE_ROW);
  });

  it("correlates two declared text keys with no cast on either side", () => {
    const { relation } = Apply(ScalarLookup());
    const from = relation.joins[0].from;
    expect(from).to.contain(MATCHING_NAME);
    expect(from).to.not.contain("to_jsonb");
    expect(from).to.not.contain("#>>");
  });

  it("reads the other query directly rather than as a correlated subquery", () => {
    expect(Apply(ScalarLookup()).subqueries).to.equal(0);
  });

  it("merges into a shaped left unguarded, spelling the document exactly once", () => {
    const sql = Sql(ScalarLookup());
    expect(sql).to.not.contain("jsonb_typeof");
    expect(sql).to.not.contain(HELD_COLUMN);
    expect(Occurrences(sql, DOCUMENT)).to.equal(1);
  });

  it("types the replaced key as the document the lateral answers with", () => {
    const { relation } = Apply(ScalarLookup());
    const shape = relation.projection?.type;
    expect(shape?.kind).to.equal("json");
    expect(shape).to.have.nested.property("shape.name.kind", "json");
    expect(shape).to.have.nested.property("shape.age.kind", "float");
  });
});

describe("a lookup whose left document carries no shape", () => {
  it("guards the merge, holding the left value on a derived table", () => {
    expect(Sql(OpaqueLookup())).to.equal(
      `SELECT ${GuardedMerge(OPAQUE_LEFT, "name", OPAQUE_LATERAL_ALIAS, OPAQUE_HELD_ALIAS)}` +
        ` AS "value" FROM ${OPAQUE_SOURCE} AS "${OPAQUE_WRAP_ALIAS}"` +
        ` ${LATERAL} ${ONE_PRODUCT_BY_OPAQUE_NAME}` +
        ` AS "${OPAQUE_LATERAL_ALIAS}" ${ON_TRUE}`,
    );
  });

  it("types the result as opaque, having no keys to carry through the merge", () => {
    const { relation } = Apply(OpaqueLookup());
    expect(relation.projection?.type).to.deep.equal({ kind: "json" });
  });
});

describe("a lookup on a local key declared as an array", () => {
  it("aggregates the lateral instead of bounding it to one row", () => {
    expect(Sql(ArrayLookup(), NewProfiles())).to.equal(
      `SELECT ${Merged(ProfileDocument(ROOT_ALIAS), "skills", COLLECTED_LATERAL_ALIAS)}` +
        ` AS "value" FROM ${PROFILES_TABLE} AS "${ROOT_ALIAS}"` +
        ` ${LATERAL} ${ALL_PRODUCTS} AS "${COLLECTED_LATERAL_ALIAS}" ${ON_TRUE}`,
    );
  });

  it("correlates by membership rather than by equality, and takes no bound", () => {
    const { relation } = Apply(ArrayLookup(), NewProfiles());
    expect(relation.joins[0].from).to.contain(MEMBER_NAME);
    expect(relation.joins[0].from).to.not.contain("LIMIT");
  });

  it("types the replaced key as an array of the documents it collected", () => {
    const { relation } = Apply(ArrayLookup(), NewProfiles());
    expect(relation.projection?.type).to.have.nested.property(
      "shape.skills.kind",
      "array",
    );
    expect(relation.projection?.type).to.have.nested.property(
      "shape.skills.elem.kind",
      "json",
    );
  });
});

describe("a lookup over a relation that has already chosen its rows", () => {
  it("keeps a single-row selection single, and keeps what it answers when absent", () => {
    const { relation } = Apply(LookupOnGet());
    expect(relation.single).to.equal(true);
    expect(relation.absent).to.equal(undefined);
    expect(relation.from).to.equal(TABLE);
    expect(relation.alias).to.equal(ROOT_ALIAS);
  });

  it("does not wrap a relation whose row bounds are already decided", () => {
    const { relation } = Apply(SlicedLookup());
    expect(relation.from).to.equal(TABLE);
    expect(relation.alias).to.equal(ROOT_ALIAS);
    expect(relation.limit).to.not.equal(undefined);
    expect(relation.joins.map((join) => join.alias)).to.deep.equal([
      LATERAL_ALIAS,
    ]);
  });

  it("wraps a relation a map already projected, and reads its value column", () => {
    const { relation } = Apply(MappedLookup());
    expect(relation.alias).to.equal(WRAP_ALIAS);
    expect(relation.joins[0].from).to.contain(
      `"${WRAP_ALIAS}"."value" -> 'label'`,
    );
    expect(relation.joins.map((join) => join.alias)).to.deep.equal([
      WRAPPED_LATERAL_ALIAS,
    ]);
  });

  it("chains, wrapping once between the two and reading the first's value column", () => {
    const sql = Sql(ChainedLookup());
    const { relation } = Apply(ChainedLookup());
    expect(relation.alias).to.equal(CHAINED_WRAP_ALIAS);
    expect(Occurrences(sql, `AS "${CHAINED_WRAP_ALIAS}"`)).to.equal(1);
    expect(Occurrences(sql, LATERAL)).to.equal(2);
    expect(relation.joins.map((join) => join.alias)).to.deep.equal([
      CHAINED_LATERAL_ALIAS,
    ]);
    expect(relation.joins[0].from).to.contain(
      `"${CHAINED_WRAP_ALIAS}"."value"`,
    );
  });

  it("is wrapped by a filter behind it, which then reads a plain column", () => {
    const { relation } = Apply(FilteredLookup());
    expect(relation.alias).to.equal(FILTER_WRAP_ALIAS);
    expect(relation.joins).to.deep.equal([]);
    expect(relation.where[0]).to.contain(
      `"${FILTER_WRAP_ALIAS}"."value" -> 'age'`,
    );
    expect(relation.where[0]).to.not.contain(LATERAL);
  });
});

describe("the lookup stage's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    const ledger = ReadParamLedger(Apply(ChainedLookup()));
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });
});
