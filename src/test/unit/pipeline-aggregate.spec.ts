import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { Render } from "../../implementations/database/relation";
import { FLOAT, TEXT, TIMESTAMP } from "../../implementations/database/types";
import {
  Apply,
  ApplyRaw,
  DOCUMENT,
  FROM_TABLE,
  Occurrences,
  ROOT_ALIAS,
  ROW_COLUMNS,
  Root,
  Sql,
  Stages,
  TABLE,
  TABLE_ID,
} from "./pipeline-fixture";

const COUNT_ALL = QueryStage("count", {});

const ACTIVE_AS_NUMBER = '(("t0"."isActive")::int::double precision)';
const META_AS_NUMBER =
  `(CASE WHEN jsonb_typeof("t0"."meta") = 'number'` +
  ` THEN (("t0"."meta" #>> '{}')::double precision) END)`;

const DOCUMENT_AS_NUMBER =
  `(CASE WHEN jsonb_typeof(${DOCUMENT}) = 'number'` +
  ` THEN ((${DOCUMENT} #>> '{}')::double precision) END)`;

const DOCUMENT_COPIES = 2;

function Selects(sql: string): string {
  return `SELECT ${sql} AS "value" ${FROM_TABLE}`;
}

describe("the count stage", () => {
  it("counts rows without materializing anything to count", () => {
    const sql = Sql(Root().count());
    expect(sql).to.equal(Selects("((count(*))::double precision)"));
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("counts a named field's distinct values, which is what the contract asserts", () => {
    expect(Sql(Root().count("name"))).to.equal(
      Selects('((count(DISTINCT "t0"."name"))::double precision)'),
    );
  });

  it("casts away the bigint the driver would otherwise hand back as a string", () => {
    expect(Apply(Root().count()).relation.projection?.type).to.deep.equal(
      FLOAT,
    );
  });

  it("absorbs into a bare table rather than wrapping it", () => {
    const { relation } = Apply(Root().count());
    expect(relation.alias).to.equal(ROOT_ALIAS);
    expect(relation.from).to.equal(TABLE);
  });

  it("marks the relation as yielding exactly one aggregated row", () => {
    const { relation } = Apply(Root().count());
    expect(relation.single).to.equal(true);
    expect(relation.aggregated).to.equal(true);
  });

  it("wraps after a slice, since the limit selects which rows are counted", () => {
    const { relation } = Apply(Root().slice(0, 2).count());
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.contain("LIMIT");
    expect(Render(relation)).to.contain("count(*)");
  });

  it("binds no parameter of its own", () => {
    expect(Apply(Root().count("name")).context.params.all()).to.deep.equal([]);
  });
});

describe("the sum stage", () => {
  it("reads the declared column, coalescing the empty sum to 0", () => {
    expect(Sql(Root().sum("age"))).to.equal(
      Selects('((COALESCE(sum("t0"."age"), 0))::double precision)'),
    );
  });

  it("reads a kind that is not a number through the numeric reading", () => {
    expect(Sql(Root().sum("isActive"))).to.equal(
      Selects(`((COALESCE(sum(${ACTIVE_AS_NUMBER}), 0))::double precision)`),
    );
  });
});

describe("the avg stage", () => {
  it("reads the declared column", () => {
    expect(Sql(Root().avg("age"))).to.equal(
      Selects('((avg("t0"."age"))::double precision)'),
    );
  });

  it("coalesces nothing, so an empty average stays null rather than reading 0", () => {
    expect(Sql(Root().avg("age"))).to.not.contain("COALESCE");
  });
});

describe("the min and max stages", () => {
  it("reads a numeric column directly, cast for the driver", () => {
    expect(Sql(Root().min("age"))).to.equal(
      Selects('((min("t0"."age"))::double precision)'),
    );
    expect(Sql(Root().max("age"))).to.equal(
      Selects('((max("t0"."age"))::double precision)'),
    );
  });

  it("keeps a text column a text answer", () => {
    const { relation } = Apply(Root().min("name"));
    expect(Render(relation)).to.equal(Selects('(min("t0"."name"))'));
    expect(relation.projection?.type).to.deep.equal(TEXT);
  });

  it("keeps a timestamp column an instant", () => {
    const { relation } = Apply(Root().max("joined"));
    expect(Render(relation)).to.equal(Selects('(max("t0"."joined"))'));
    expect(relation.projection?.type).to.deep.equal(TIMESTAMP);
  });

  it("falls back to a numeric reading for a boolean, which has no min", () => {
    expect(Sql(Root().min("isActive"))).to.equal(
      Selects(`((min(${ACTIVE_AS_NUMBER}))::double precision)`),
    );
  });

  it("falls back to a numeric reading for a jsonb member, which has no min", () => {
    const { relation } = Apply(Root().max("meta"));
    expect(Render(relation)).to.equal(
      Selects(`((max(${META_AS_NUMBER}))::double precision)`),
    );
    expect(relation.projection?.type).to.deep.equal(FLOAT);
  });

  it("reads a wrapped projection's own type, not just a table column's", () => {
    const { relation } = Apply(
      Root()
        .map((doc) => doc.key("name"))
        .min(),
    );
    expect(Render(relation)).to.equal(
      `SELECT (min("t1"."value")) AS "value"` +
        ` FROM (SELECT "t0"."name" AS "value" ${FROM_TABLE}) AS "t1"`,
    );
    expect(relation.projection?.type).to.deep.equal(TEXT);
  });
});

describe("an aggregate that names no field", () => {
  it("sums the whole materialized document through the numeric reading", () => {
    expect(Sql(Root().sum())).to.equal(
      Selects(`((COALESCE(sum(${DOCUMENT_AS_NUMBER}), 0))::double precision)`),
    );
  });

  it("takes the minimum of it the same way, jsonb having no ordering", () => {
    expect(Sql(Root().min())).to.equal(
      Selects(`((min(${DOCUMENT_AS_NUMBER}))::double precision)`),
    );
  });

  it("guards it as a json number, which a row-mode document never is", () => {
    expect(Sql(Root().sum())).to.contain(
      `jsonb_typeof(${DOCUMENT}) = 'number'`,
    );
    expect(DOCUMENT).to.contain("jsonb_build_object");
  });

  it("spells that document twice, which is the guard cost decision 10 defers", () => {
    expect(Occurrences(Sql(Root().avg()), DOCUMENT)).to.equal(DOCUMENT_COPIES);
  });
});

describe("what every aggregate does to the relation", () => {
  it("clears the order terms, since a non-grouped ORDER BY beside one raises 42803", () => {
    const { relation } = Apply(Root().orderBy("name", "asc").sum("age"));
    expect(relation.orderBy).to.deep.equal([]);
    expect(Render(relation)).to.not.contain("ORDER BY");
  });

  it("absorbs the ordering and clears it, on count's own code path", () => {
    const { relation } = Apply(Root().orderBy("name", "asc").count());
    expect(relation.alias).to.equal(ROOT_ALIAS);
    expect(relation.orderBy).to.deep.equal([]);
    expect(Render(relation)).to.not.contain("ORDER BY");
  });

  it("keeps the rows an ordering was applied to, filter and all", () => {
    const sql = Sql(
      Root()
        .filter((doc) => doc.key("age").gt(25))
        .orderBy("name", "asc")
        .avg("age"),
    );
    expect(sql).to.equal(
      `SELECT ((avg("t0"."age"))::double precision) AS "value" ${FROM_TABLE}` +
        ' WHERE (("t0"."age" > ($1::double precision)))',
    );
  });

  it("wraps a second aggregate, which reads the first one's row", () => {
    const { relation } = ApplyRaw([COUNT_ALL, QueryStage("sum", {})]);
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.contain("count(*)");
  });

  it("wraps a filter that follows it, since a WHERE cannot read an aggregate", () => {
    const filtered = Stages(Root().filter((doc) => doc.key("age").gt(25)));
    const { relation } = ApplyRaw([COUNT_ALL, ...filtered]);
    expect(relation.alias).to.equal("t1");
    expect(relation.aggregated).to.equal(false);
    expect(relation.from).to.contain("count(*)");
  });

  it("lets default wrap it, so count().default(0) is one value", () => {
    const { relation } = Apply(Root().count().default(0));
    expect(Render(relation)).to.equal(
      `SELECT COALESCE("t1"."value", ($1::double precision)) AS "value"` +
        ` FROM (SELECT ((count(*))::double precision) AS "value"` +
        ` ${FROM_TABLE}) AS "t1"`,
    );
    expect(relation.single).to.equal(true);
  });
});

describe("the distinct stage", () => {
  it("sets both the flag and the projection when a field is named", () => {
    const { relation } = Apply(Root().distinct("isActive"));
    expect(relation.distinct).to.equal(true);
    expect(relation.projection?.sql).to.equal('"t0"."isActive"');
    expect(Render(relation)).to.equal(
      `SELECT DISTINCT "t0"."isActive" AS "value" ${FROM_TABLE}`,
    );
  });

  it("dedups whole rows when no field is named, keeping the relation row-shaped", () => {
    const { relation } = Apply(Root().distinct());
    expect(relation.projection).to.equal(undefined);
    expect(relation.origin?.tableId).to.equal(TABLE_ID);
    expect(Render(relation)).to.equal(
      `SELECT DISTINCT ${ROW_COLUMNS} ${FROM_TABLE}`,
    );
  });

  it("yields a stream rather than a single value", () => {
    expect(Apply(Root().distinct("isActive")).relation.single).to.equal(false);
  });

  it("wraps an existing ordering inside, since 42P10 refuses it beside DISTINCT", () => {
    const { relation } = Apply(Root().orderBy("name", "asc").distinct("age"));
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.contain('ORDER BY "t0"."name" ASC');
    expect(relation.orderBy).to.deep.equal([]);
    expect(Render(relation)).to.contain('SELECT DISTINCT "t1"."age"');
  });

  it("wraps an offset inside, since it selects which rows there are to dedup", () => {
    const { relation } = Apply(Root().slice(1).distinct("age"));
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.contain("OFFSET");
    expect(Render(relation)).to.contain('SELECT DISTINCT "t1"."age"');
  });

  it("wraps an aggregate rather than dedupping its single row in place", () => {
    const { relation } = ApplyRaw([COUNT_ALL, QueryStage("distinct", {})]);
    expect(relation.alias).to.equal("t1");
    expect(relation.aggregated).to.equal(false);
    expect(relation.from).to.contain("count(*)");
  });

  it("wraps a second distinct rather than collapsing it into the first", () => {
    const { relation } = Apply(Root().distinct("age").distinct());
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.contain("SELECT DISTINCT");
  });

  it("counts a distinct stream by wrapping it", () => {
    const { relation } = Apply(Root().distinct("age").count());
    expect(relation.alias).to.equal("t1");
    expect(Render(relation)).to.contain("count(*)");
  });
});
