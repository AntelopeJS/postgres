import assert from "node:assert";
import { expect } from "chai";
import {
  type Relation,
  Render,
  SetProjection,
} from "../../implementations/database/relation";
import {
  BOOL,
  FLOAT,
  JsonOf,
  ShapeOf,
  type SqlShape,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  Apply,
  DOCUMENT,
  FROM_TABLE,
  NewTable,
  Occurrences,
  OTHER_TABLE,
  Other,
  PeopleDocument,
  type Person,
  ReadParamLedger,
  Root,
  Sql,
  TABLE,
  TABLE_ID,
} from "./pipeline-fixture";

const AGE_OVER_25 = '("t0"."age" > ($1::double precision))';
const AGE_CLAUSE = `(${AGE_OVER_25})`;
const OFFSET_BOUND =
  "((CASE WHEN ($1::double precision) IS NOT NULL THEN" +
  " LEAST(GREATEST(trunc(($1::double precision)), 0), 2147483647) END)::bigint)";
const COUNT_BOUND =
  "((CASE WHEN ($2::double precision) IS NOT NULL THEN" +
  " LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)";
const SINGLE_ROW = "((1)::bigint)";

function Reshaped(): Relation {
  return SetProjection(NewTable(), {
    sql: '"t0"."_extra"',
    type: JsonOf({ name: TEXT, age: FLOAT }),
  });
}

describe("the filter stage", () => {
  it("absorbs a predicate into WHERE", () => {
    const { relation, context } = Apply(
      Root().filter((doc) => doc.key("age").gt(25)),
    );
    expect(relation.where).to.deep.equal([AGE_CLAUSE]);
    expect(context.params.all()).to.deep.equal([25]);
  });

  it("parenthesises the condition it absorbs, so a conjunct cannot rebind it", () => {
    const sql = Sql(
      Root()
        .filter((doc) => doc.key("age").gt(25))
        .filter((doc) => doc.key("isActive").eq(true)),
    );
    expect(sql).to.contain(`WHERE ${AGE_CLAUSE} AND (`);
  });

  it("reads the declared column rather than a materialized document", () => {
    const sql = Sql(Root().filter((doc) => doc.key("age").gt(25)));
    expect(sql).to.contain(`WHERE ${AGE_CLAUSE}`);
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("keeps the relation row-shaped", () => {
    const { relation } = Apply(Root().filter((doc) => doc.key("age").gt(25)));
    expect(relation.projection).to.equal(undefined);
    expect(relation.origin?.tableId).to.equal(TABLE_ID);
  });

  it("absorbs a second predicate beside the first", () => {
    const { relation } = Apply(
      Root()
        .filter((doc) => doc.key("age").gt(25))
        .filter((doc) => doc.key("isActive").eq(true)),
    );
    expect(relation.where).to.have.lengthOf(2);
    expect(Render(relation)).to.contain(" AND ");
  });

  it("wraps after a slice and still reaches the column", () => {
    const sql = Sql(
      Root()
        .slice(0, 2)
        .filter((doc) => doc.key("age").gt(25)),
    );
    expect(sql).to.contain('WHERE (("t1"."age" > ($3::double precision)))');
    expect(sql).to.not.contain("jsonb_build_object");
  });
});

describe("the orderBy stage", () => {
  it("sorts ascending when no direction is named", () => {
    expect(Sql(Root().orderBy("name"))).to.contain('ORDER BY "t0"."name" ASC');
  });

  it("spells a descending sort", () => {
    expect(Sql(Root().orderBy("age", "desc"))).to.contain(
      'ORDER BY "t0"."age" DESC',
    );
  });

  it("names no null ordering, so a btree index still serves the sort", () => {
    expect(Sql(Root().orderBy("name", "asc"))).to.not.contain("NULLS");
  });

  it("lets a later sort dominate an earlier one", () => {
    expect(
      Sql(Root().orderBy("name", "asc").orderBy("age", "desc")),
    ).to.contain('ORDER BY "t0"."age" DESC, "t0"."name" ASC');
  });

  it("collapses a whole chain into one clause", () => {
    const { relation } = Apply(
      Root().orderBy("name", "asc").orderBy("age", "desc"),
    );
    expect(relation.orderBy).to.have.lengthOf(2);
    expect(relation.from).to.equal(TABLE);
  });

  it("expands a declared multi-field index in its declared order", () => {
    expect(Sql(Root().orderBy("byNameAge", "desc"))).to.contain(
      'ORDER BY "t0"."name" DESC, "t0"."age" DESC',
    );
  });

  it("sorts an undeclared key out of the overflow column", () => {
    expect(Sql(Root().orderBy("nickname"))).to.contain(
      `ORDER BY ("t0"."_extra" -> 'nickname') ASC`,
    );
  });

  it("treats the name as a single field once the relation is reshaped", () => {
    const sql = Sql(Root().orderBy("byNameAge", "asc"), Reshaped());
    expect(sql).to.contain(`ORDER BY ("t1"."value" -> 'byNameAge') ASC`);
    expect(sql).to.not.contain('"t1"."age"');
  });

  it("wraps after a limit, since the sort would otherwise reorder it", () => {
    const { relation } = Apply(Root().slice(0, 2).orderBy("name", "asc"));
    expect(relation.alias).to.equal("t1");
    expect(relation.orderBy).to.deep.equal([
      { sql: '"t1"."name"', descending: false },
    ]);
  });
});

describe("the row bounds slice and nth emit", () => {
  it("hands every bound to the same clamp, since the value itself is a parameter", () => {
    const { relation, context } = Apply(
      Root().slice(Number.NaN, Number.POSITIVE_INFINITY),
    );
    expect(relation.offset).to.equal(OFFSET_BOUND);
    expect(relation.limit).to.equal(COUNT_BOUND);
    expect(context.params.all()).to.deep.equal([
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]);
  });

  it("bounds both ends and truncates, so no bound raises 22003 or 22023", () => {
    expect(Apply(Root().slice(0, 1e20)).relation.limit).to.contain(
      "LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647)",
    );
  });

  it("leaves an unreadable bound NULL, which reads as no bound rather than none", () => {
    const limit = Apply(Root().slice(0, 2)).relation.limit;
    expect(limit).to.contain("CASE WHEN ($2::double precision) IS NOT NULL");
    expect(limit).to.not.contain("GREATEST(($2::double precision), 0)");
  });
});

describe("the slice stage", () => {
  it("bounds both ends and hands the driver a bigint", () => {
    const { relation, context } = Apply(Root().slice(1, 2));
    expect(relation.offset).to.equal(OFFSET_BOUND);
    expect(relation.limit).to.equal(COUNT_BOUND);
    expect(context.params.all()).to.deep.equal([1, 2]);
  });

  it("sets only the offset when no count is given", () => {
    const { relation, context } = Apply(Root().slice(3));
    expect(relation.offset).to.equal(OFFSET_BOUND);
    expect(relation.limit).to.equal(undefined);
    expect(context.params.all()).to.deep.equal([3]);
  });

  it("leaves the relation yielding a stream", () => {
    expect(Apply(Root().slice(0, 2)).relation.single).to.equal(false);
  });

  it("wraps a second slice rather than overwriting the first", () => {
    const { relation } = Apply(Root().slice(0, 4).slice(1, 2));
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.contain("LIMIT");
  });
});

describe("the nth stage", () => {
  it("takes one row at the given offset", () => {
    const { relation } = Apply(Root().nth(0));
    expect(relation.offset).to.equal(OFFSET_BOUND);
    expect(relation.limit).to.equal(SINGLE_ROW);
  });

  it("marks the relation as yielding exactly one row", () => {
    expect(Apply(Root().nth(0)).relation.single).to.equal(true);
  });

  it("wraps when an offset is already set", () => {
    const { relation } = Apply(Root().slice(2).nth(0));
    expect(relation.alias).to.equal("t1");
    expect(relation.single).to.equal(true);
    expect(relation.from).to.contain("OFFSET");
  });
});

const RIGHT_SOURCE = `FROM ${OTHER_TABLE} AS "t1"`;
const UNION_SELECTS = 2;

const PRODUCT_DOCUMENT =
  `(jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", 'name', "t1"."name",` +
  ` 'price', "t1"."price")) || COALESCE("t1"."_extra", '{}'::jsonb))`;

const PLAIN_UNION =
  `SELECT "t2"."value" AS "value" FROM ((SELECT ${DOCUMENT}` +
  ` AS "value" ${FROM_TABLE}) UNION ALL (SELECT ${PRODUCT_DOCUMENT}` +
  ` AS "value" ${RIGHT_SOURCE} WHERE ("t1"."_instance" = ($1::text)))) AS "t2"`;

const SELF_UNION =
  `SELECT "t2"."value" AS "value" FROM ((SELECT ${DOCUMENT}` +
  ` AS "value" ${FROM_TABLE} WHERE (("t0"."age" > ($1::double precision))))` +
  ` UNION ALL (SELECT ${PeopleDocument("t1")} AS "value" FROM ${TABLE} AS "t1"` +
  ` WHERE ("t1"."_instance" = ($2::text))` +
  ` AND (("t1"."age" > ($3::double precision))))) AS "t2"`;

const SCALAR_UNION =
  `SELECT "t2"."value" AS "value" FROM ((SELECT to_jsonb("t0"."name")` +
  ` AS "value" ${FROM_TABLE}) UNION ALL (SELECT ${PRODUCT_DOCUMENT}` +
  ` AS "value" ${RIGHT_SOURCE} WHERE ("t1"."_instance" = ($1::text)))) AS "t2"`;

const DISTINCT_SCALAR_SIDE = `SELECT DISTINCT to_jsonb("t0"."name") AS "value"`;

const MIXED_SCALAR_UNION =
  `SELECT "t2"."value" AS "value" FROM ((SELECT to_jsonb("t0"."name")` +
  ` AS "value" ${FROM_TABLE}) UNION ALL (SELECT to_jsonb("t1"."age")` +
  ` AS "value" FROM ${TABLE} AS "t1"` +
  ` WHERE ("t1"."_instance" = ($1::text)))) AS "t2"`;

const SAME_SCALAR_UNION =
  `SELECT "t2"."value" AS "value" FROM ((SELECT "t0"."age" AS "value"` +
  ` ${FROM_TABLE}) UNION ALL (SELECT "t1"."price" AS "value" ${RIGHT_SOURCE}` +
  ` WHERE ("t1"."_instance" = ($1::text)))) AS "t2"`;

const PROJECTED_TIMESTAMP =
  `(CASE WHEN jsonb_typeof("t1"."meta") = 'string'` +
  ` AND pg_input_is_valid(("t1"."meta" #>> '{}'), 'timestamptz')` +
  ` THEN (("t1"."meta" #>> '{}')::timestamptz) END)`;

const TIMESTAMP_UNION =
  `SELECT "t2"."value" AS "value" FROM ((SELECT "t0"."joined" AS "value"` +
  ` ${FROM_TABLE}) UNION ALL (SELECT ${PROJECTED_TIMESTAMP} AS "value"` +
  ` FROM ${TABLE} AS "t1"` +
  ` WHERE ("t1"."_instance" = ($1::text)))) AS "t2"`;

const WIDENED_KEYS = [
  "_id",
  "age",
  "isActive",
  "joined",
  "meta",
  "name",
  "price",
];

function UnionShape(relation: Relation): SqlShape {
  const projection = relation.projection;
  assert(projection, "a union must leave a projection behind");
  const shape = ShapeOf(projection.type);
  assert(shape, "a union of two documents must stay shaped");
  return shape;
}

describe("the union stage", () => {
  it("concatenates two single-column selects under one alias", () => {
    expect(Sql(Root().union(Other()))).to.equal(PLAIN_UNION);
  });

  it("concatenates with UNION ALL, so duplicates survive", () => {
    const sql = Sql(Root().union(Other()));
    expect(sql).to.contain("UNION ALL");
    expect(Occurrences(sql, "UNION")).to.equal(Occurrences(sql, "UNION ALL"));
  });

  it("keeps the two sides apart when both read the same table", () => {
    expect(
      Sql(
        Root()
          .filter((doc) => doc.key("age").gt(25))
          .union(Root().filter((doc) => doc.key("age").gt(30))),
      ),
    ).to.equal(SELF_UNION);
  });

  it("parenthesises each side, since either may carry its own bounds", () => {
    const sql = Sql(Root().orderBy("name").union(Other().slice(0, 2)));
    expect(sql).to.contain("FROM ((SELECT ");
    expect(sql).to.contain(") UNION ALL (SELECT ");
    expect(sql).to.contain(`)) AS "t2"`);
    expect(sql).to.contain('ORDER BY "t0"."name" ASC)');
  });

  it("renders each side exactly once", () => {
    const { relation, context } = Apply(Root().union(Other()));
    const sql = Render(relation);
    expect(Occurrences(sql, FROM_TABLE)).to.equal(1);
    expect(Occurrences(sql, RIGHT_SOURCE)).to.equal(1);
    expect(context.params.all()).to.deep.equal([""]);
  });

  it("materializes a row-mode side through toJson rather than wrapping it", () => {
    const { relation } = Apply(Root().union(Other()));
    expect(relation.from).to.contain("jsonb_strip_nulls(jsonb_build_object(");
    expect(relation.from).to.contain(`${FROM_TABLE})`);
    expect(Occurrences(relation.from, "SELECT")).to.equal(UNION_SELECTS);
  });

  it("compiles the right side's own stages against the same context", () => {
    const sql = Sql(Root().union(Other().filter((p) => p.key("price").gt(10))));
    expect(sql).to.contain('WHERE ("t1"."_instance" = ($1::text))');
    expect(sql).to.contain('AND (("t1"."price" > ($2::double precision)))');
  });

  it("reads the nested query directly rather than as a correlated subquery", () => {
    expect(Apply(Root().union(Other())).subqueries).to.equal(0);
  });

  it("references every parameter it binds, and binds every one it references", () => {
    const ledgers = [
      ReadParamLedger(Apply(Root().union(Other()))),
      ReadParamLedger(
        Apply(Root().union(Other().filter((p) => p.key("price").gt(10)))),
      ),
      ReadParamLedger(Apply(Root().union(Other()).union(Other()))),
      ReadParamLedger(Apply(Root().slice(0, 2).union(Other()).count())),
    ];
    for (const ledger of ledgers) {
      expect(ledger.referenced).to.deep.equal(ledger.bound);
    }
  });

  it("widens the two shapes instead of intersecting them", () => {
    const shape = UnionShape(Apply(Root().union(Other())).relation);
    expect(Object.keys(shape).sort()).to.deep.equal(WIDENED_KEYS);
  });

  it("keeps the type of a key only one side declares", () => {
    const shape = UnionShape(Apply(Root().union(Other())).relation);
    expect(shape.age).to.deep.equal(FLOAT);
    expect(shape.isActive).to.deep.equal(BOOL);
    expect(shape.price).to.deep.equal(FLOAT);
    expect(shape.name).to.deep.equal(TEXT);
  });

  it("spells a scalar side as jsonb, which is what a row-mode side projects", () => {
    expect(
      Sql(
        Root()
          .map((doc) => doc.key("name"))
          .union(Other()),
      ),
    ).to.equal(SCALAR_UNION);
  });

  it("spells a scalar side as jsonb whichever stage projected it", () => {
    expect(Sql(Root().key("name").union(Other()))).to.equal(SCALAR_UNION);
    expect(Sql(Root().distinct("name").union(Other()))).to.contain(
      DISTINCT_SCALAR_SIDE,
    );
  });

  it("spells two scalar sides of different types as jsonb", () => {
    expect(
      Sql(
        Root()
          .map((doc) => doc.key("name"))
          .union(Root().map((doc) => doc.key("age"))),
      ),
    ).to.equal(MIXED_SCALAR_UNION);
  });

  it("leaves two sides of one scalar type on their own columns", () => {
    const { relation } = Apply(
      Root()
        .map((doc) => doc.key("age"))
        .union(Other().map((product) => product.key("price"))),
    );
    expect(Render(relation)).to.equal(SAME_SCALAR_UNION);
    expect(relation.projection?.type).to.deep.equal(FLOAT);
  });

  it("keeps the more specific of two scalar sides, casting the other to it", () => {
    const { relation } = Apply(
      Root()
        .map((doc) => doc.key("joined"))
        .union(Root().map((doc) => doc.key("meta"))),
    );
    expect(relation.projection?.type).to.deep.equal(TIMESTAMP);
    expect(Render(relation)).to.equal(TIMESTAMP_UNION);
  });

  it("yields a stream rather than a single row", () => {
    const { relation } = Apply(Root().union(Other()));
    expect(relation.single).to.equal(false);
    expect(relation.origin).to.equal(undefined);
    expect(relation.projection?.sql).to.equal('"t2"."value"');
  });

  it("wraps a following count, since the union is already a projection", () => {
    const { relation } = Apply(Root().union(Other()).count());
    expect(relation.alias).to.equal("t3");
    expect(relation.from).to.contain("UNION ALL");
    expect(relation.projection?.sql).to.contain("count(*)");
    expect(relation.single).to.equal(true);
  });

  it("wraps a following filter, which then reads the union's own column", () => {
    const sql = Sql(
      Root()
        .union(Other())
        .cast<Person>()
        .filter((doc) => doc.key("age").gt(25)),
    );
    expect(sql).to.contain(`"t3"."value" -> 'age'`);
    expect(Occurrences(sql, "UNION ALL")).to.equal(1);
  });

  it("chains, nesting one union inside the next", () => {
    const { relation } = Apply(Root().union(Other()).union(Other()));
    expect(relation.alias).to.equal("t4");
    expect(Occurrences(relation.from, "UNION ALL")).to.equal(2);
    expect(Object.keys(UnionShape(relation)).sort()).to.deep.equal(
      WIDENED_KEYS,
    );
  });
});
