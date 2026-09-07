import { expect } from "chai";
import assert from "node:assert";
import { Query, Stream } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";

import type { Compiled } from "../../implementations/database/sql";
import { DecodeValue } from "../../implementations/database/value";
import { CompileSubquery } from "../../implementations/database/subquery";
import type { DecodingContext } from "../../implementations/database/context";
import { SubStreamProvider } from "../../implementations/database/stages-group";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  TEXT,
} from "../../implementations/database/types";
import {
  type Relation,
  Render,
  SetProjection,
} from "../../implementations/database/relation";
import {
  type Applied,
  Apply,
  ApplyRaw,
  ApplySubqueries,
  DOCUMENT,
  type ParamLedger,
  type Person,
  ReadParamLedger,
  Root,
  Write,
} from "./pipeline-fixture";

const LAMBDA_ID_FLOOR = 0;
const STREAM_ID = LAMBDA_ID_FLOOR - 1;
const VALUE_ID = LAMBDA_ID_FLOOR - 2;

const AGE_COLUMN = '"t0"."age"';
const NAME_COLUMN = '"t0"."name"';
const ACTIVE_COLUMN = '"t0"."isActive"';
const SKILLS_KEY = `("t0"."_extra" -> 'skills')`;
const DEDUPED = "DISTINCT ";
const UNNAMED = "unnamed";
const NO_SUBQUERIES = 0;

const COMPOUND_INDEX = "byNameAge";
const CONTAINER_INDEX = "byNameSkills";
const SINGLE_TERM = 1;
const ONLY_TERM = 0;
const WRAPPED_ALIAS = "t1";
const DELETE_STAGE = "delete";
const NO_ORIGIN = "A row-mode relation must carry the origin of its table";

interface Grouped {
  relation: Relation;
  context: DecodingContext;
}

/**
 * A bare table with the stream parameter bound to its sub-stream provider, as `group` will bind it.
 *
 * The relation is the fixture's own, so every text these specs compare against a whole-stream stage
 * is compared over the same alias and the same shape.
 */
function GroupedTable(): Grouped {
  const { relation, context } = ApplySubqueries(Root());
  context.bind(STREAM_ID, SubStreamProvider(relation, context));
  return { relation, context };
}

function GroupStream(): Stream<Person> {
  return new Stream<Person>(QueryStage("arg", undefined, STREAM_ID));
}

type SubStreamBuild = (stream: Stream<Person>) => StagedObject;

function SubValue(build: SubStreamBuild): Compiled {
  const { context } = GroupedTable();
  return CompileSubquery(build(GroupStream()).build(), context);
}

function SubSql(build: SubStreamBuild): string {
  return SubValue(build).sql;
}

/**
 * The expression a whole-stream stage projects, which is what its sub-stream twin must also emit.
 *
 * Read off the compiled relation rather than transcribed, so the two spellings that must agree are
 * compared against each other rather than against a pair of independently written strings that a
 * change to the spelling would leave agreeing with neither.
 */
function WholeStreamSql(query: StagedObject): string {
  const projection = Apply(query).relation.projection;
  assert(projection, "this fixture compiles a query that projects a value");
  return projection.sql;
}

interface AggregateCase {
  name: string;
  sub: SubStreamBuild;
  whole: () => StagedObject;
}

interface RefusedCase {
  name: string;
  sub: SubStreamBuild;
}

const NAMED_AGGREGATES: AggregateCase[] = [
  { name: "sum", sub: (s) => s.sum("age"), whole: () => Root().sum("age") },
  { name: "avg", sub: (s) => s.avg("age"), whole: () => Root().avg("age") },
  { name: "min", sub: (s) => s.min("name"), whole: () => Root().min("name") },
  {
    name: "max",
    sub: (s) => s.max("joined"),
    whole: () => Root().max("joined"),
  },
];

const WHOLE_VALUE_AGGREGATES: AggregateCase[] = [
  { name: "sum", sub: (s) => s.sum(), whole: () => Root().sum() },
  { name: "avg", sub: (s) => s.avg(), whole: () => Root().avg() },
  { name: "min", sub: (s) => s.min(), whole: () => Root().min() },
  { name: "max", sub: (s) => s.max(), whole: () => Root().max() },
];

function Collects(target: string, deduped = ""): string {
  return `COALESCE(jsonb_agg(${deduped}${target}), '[]'::jsonb)`;
}

/**
 * The bind ledger of a mapper's document of sub-streams, projected as `group` will project it.
 *
 * The bind ledger over the one position that can break it without any stage being wrong: a sub-stream
 * that decodes a body and then answers something the body is not part of leaves the statement
 * binding a `$n` no fragment references.
 */
function LedgerOver(members: Record<string, StagedObject>): ParamLedger {
  const { relation, context } = GroupedTable();
  const document = DecodeValue(members, context);
  assert(document, "this fixture compiles a document of sub-streams");
  return ReadParamLedger({
    relation: SetProjection(relation, document),
    context,
    subqueries: NO_SUBQUERIES,
  });
}

describe("a sub-stream reached through the stream parameter", () => {
  it("compiles the stages after the arg rather than the arg alone", () => {
    expect(SubSql((stream) => stream.count())).to.contain("count(*)");
  });

  it("never routes through the relation compiler, which has no root to read", () => {
    expect(() => SubValue((stream) => stream.count())).to.not.throw();
  });

  it("still routes an arg bound to a value through the relation compiler", () => {
    const { context } = GroupedTable();
    context.bind(VALUE_ID, { sql: "1", type: FLOAT });
    expect(() =>
      CompileSubquery([QueryStage("arg", undefined, VALUE_ID)], context),
    ).to.throw(/must open with schema, instance, table/);
  });
});

describe("a sub-stream's count", () => {
  it("counts rows, exactly as the whole-stream count does", () => {
    expect(SubSql((stream) => stream.count())).to.equal(
      WholeStreamSql(Root().count()),
    );
  });

  it("materializes no document to count", () => {
    const sql = SubSql((stream) => stream.count());
    expect(sql).to.contain("count(*)");
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("counts a named field's distinct values, as the whole-stream count does", () => {
    expect(SubSql((stream) => stream.count("name"))).to.equal(
      WholeStreamSql(Root().count("name")),
    );
    expect(SubSql((stream) => stream.count("name"))).to.contain(
      `count(DISTINCT ${NAME_COLUMN})`,
    );
  });

  it("counts rows after a map too, since count(*) skips no null", () => {
    const mapped = SubSql((stream) =>
      stream.map((row) => row.key("name")).count(),
    );
    expect(mapped).to.equal(SubSql((stream) => stream.count()));
    expect(mapped).to.contain("count(*)");
  });

  it("counts the values a pending distinct chose rather than the rows", () => {
    const deduped = SubSql((stream) => stream.distinct("name").count());
    expect(deduped).to.equal(SubSql((stream) => stream.count("name")));
    expect(deduped).to.contain(`count(DISTINCT ${NAME_COLUMN})`);
  });
});

describe("a sub-stream's four value aggregates", () => {
  for (const one of NAMED_AGGREGATES) {
    it(`emits over a named field what the whole-stream ${one.name} emits`, () => {
      expect(SubSql(one.sub)).to.equal(WholeStreamSql(one.whole()));
    });
  }

  for (const one of WHOLE_VALUE_AGGREGATES) {
    it(`emits over the whole row what the whole-stream ${one.name} emits`, () => {
      expect(SubSql(one.sub)).to.equal(WholeStreamSql(one.whole()));
    });
  }

  it("reads the declared column rather than a member of a document", () => {
    expect(SubSql((stream) => stream.sum("age"))).to.equal(
      `((COALESCE(sum(${AGE_COLUMN}), 0))::double precision)`,
    );
  });

  it("reads the mapped value once a map has replaced it", () => {
    expect(
      SubSql((stream) => stream.map((row) => row.key("age")).sum()),
    ).to.equal(SubSql((stream) => stream.sum("age")));
  });

  it("carries the aggregate's own type rather than the group's", () => {
    expect(SubValue((stream) => stream.sum("age")).type).to.deep.equal(FLOAT);
  });
});

describe("a sub-stream's pending dedup, spent by the terminal after it", () => {
  it("adds up the distinct values rather than every one of them", () => {
    expect(SubSql((stream) => stream.distinct("age").sum())).to.equal(
      `((COALESCE(sum(${DEDUPED}${AGE_COLUMN}), 0))::double precision)`,
    );
  });

  it("averages the distinct values rather than every one of them", () => {
    expect(SubSql((stream) => stream.distinct("age").avg())).to.equal(
      `((avg(${DEDUPED}${AGE_COLUMN}))::double precision)`,
    );
  });

  it("carries into an extremum too, where it cannot change the answer", () => {
    expect(SubSql((stream) => stream.distinct("age").min())).to.contain(
      `min(${DEDUPED}${AGE_COLUMN})`,
    );
  });

  it("dedups the mapped value when a map follows the distinct", () => {
    expect(
      SubSql((stream) =>
        stream
          .distinct("age")
          .map((row) => row.add(1))
          .sum(),
      ),
    ).to.contain(`sum(${DEDUPED}`);
  });

  it("leaves an undeduped sub-stream exactly as it was", () => {
    for (const one of [...NAMED_AGGREGATES, ...WHOLE_VALUE_AGGREGATES]) {
      expect(SubSql(one.sub)).to.not.contain(DEDUPED);
    }
  });

  it("is never what a whole-stream aggregate emits, which asks for no dedup", () => {
    for (const one of [...NAMED_AGGREGATES, ...WHOLE_VALUE_AGGREGATES]) {
      expect(WholeStreamSql(one.whole())).to.not.contain(DEDUPED);
    }
  });
});

describe("a sub-stream that is still a stream", () => {
  it("collects the bare parameter into a jsonb array, empty rather than null", () => {
    expect(SubSql((stream) => stream)).to.equal(Collects(DOCUMENT));
  });

  it("types the bare parameter as an array of what a row yields", () => {
    const collected = SubValue((stream) => stream);
    expect(collected.type.kind).to.equal("array");
  });

  it("collects a distinct field with DISTINCT, and yields an array of it", () => {
    const collected = SubValue((stream) => stream.distinct("name"));
    expect(collected.sql).to.equal(
      Collects(`to_jsonb(${NAME_COLUMN})`, "DISTINCT "),
    );
    expect(collected.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("collects a mapped stream without a DISTINCT it was never asked for", () => {
    const collected = SubSql((stream) => stream.map((row) => row.key("name")));
    expect(collected).to.equal(Collects(`to_jsonb(${NAME_COLUMN})`));
  });
});

describe("what a sub-stream refuses", () => {
  const REFUSED: RefusedCase[] = [
    { name: "filter", sub: (s) => s.filter((row) => row.key("isActive")) },
    { name: "orderBy", sub: (s) => s.orderBy("name") },
    { name: "slice", sub: (s) => s.slice(0, 2) },
    { name: "pluck", sub: (s) => s.pluck("name") },
    { name: "nth", sub: (s) => s.nth(0) },
  ];

  for (const one of REFUSED) {
    it(`names ${one.name} and the position it cannot appear in`, () => {
      expect(() => SubValue(one.sub)).to.throw(
        new RegExp(
          `The '${one.name}' stage cannot appear in a group's sub-stream`,
        ),
      );
    });
  }

  it("names filter itself rather than the value it was given", () => {
    expect(() =>
      SubValue((stream) => stream.filter((row) => row.key("isActive"))),
    ).to.throw(/'filter' stage cannot appear in a group's sub-stream/);
  });

  it("says the stage is legal outside the group, since the same one is", () => {
    expect(() => SubValue((stream) => stream.orderBy("name"))).to.throw(
      /legal on the query outside the group/,
    );
  });

  it("refuses a second terminal rather than reading one aggregate into another", () => {
    const { context } = GroupedTable();
    const twice = [
      QueryStage("arg", undefined, STREAM_ID),
      QueryStage("count", {}),
      QueryStage("count", {}),
    ];
    expect(() => CompileSubquery(twice, context)).to.throw(
      /'count' stage cannot follow an aggregate in a group's sub-stream/,
    );
  });
});

describe("a mapper binding several sub-streams", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    const ledger = LedgerOver({
      total: GroupStream()
        .map((row) => row.key("age").default(0))
        .sum(),
      names: GroupStream().distinct("name"),
      oldest: GroupStream()
        .map((row) => row.key("age").default(1))
        .max(),
    });
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });

  it("binds nothing for a map whose count discards the value it built", () => {
    const ledger = LedgerOver({
      rows: GroupStream()
        .map((row) => row.key("age").default(0))
        .count(),
    });
    expect(ledger.bound).to.deep.equal([]);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });

  it("still binds for a map whose count deduped what it built", () => {
    const ledger = LedgerOver({
      rows: GroupStream()
        .distinct("name")
        .map((row) => row.default(UNNAMED))
        .count(),
    });
    expect(ledger.bound).to.not.deep.equal([]);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });

  it("seeds every one of them from the same row, whatever the others did", () => {
    const { context } = GroupedTable();
    const first = CompileSubquery(
      GroupStream()
        .map((row) => row.key("name"))
        .build(),
      context,
    );
    const second = CompileSubquery(GroupStream().build(), context);
    expect(first.sql).to.not.equal(second.sql);
    expect(second.sql).to.equal(Collects(DOCUMENT));
  });
});

/**
 * A group whose mapper answers the group value alone, which is what puts the term in the select
 * list where a spec can read it back.
 */
function GroupedBy(index: string): Applied {
  return ApplySubqueries(Root().group(index, (_stream, group) => group));
}

/** The one term of a group that resolved to a single column. */
function OneTerm(applied: Applied): Compiled {
  expect(applied.relation.groupBy).to.have.lengthOf(SINGLE_TERM);
  return applied.relation.groupBy[ONLY_TERM];
}

function TermTexts(applied: Applied): string[] {
  return applied.relation.groupBy.map((term) => term.sql);
}

function SelectedValue(applied: Applied): string {
  const projection = applied.relation.projection;
  assert(projection, "a group projects the value its mapper answered");
  return projection.sql;
}

/**
 * A `delete` behind a group, recorded the way the contract records one.
 *
 * A group yields a stream the contract gives no `delete` to, so the stage is appended rather than
 * chained — the refusal under test is the compiler's rather than the type system's.
 */
function Deleting(): StagedObject {
  return new Query<number>(
    QueryStage(DELETE_STAGE),
    Root().group("age", (_stream, group) => group),
  );
}

describe("the group stage", () => {
  it("groups by the one column a plain field name resolves to", () => {
    expect(TermTexts(GroupedBy("age"))).to.deep.equal([AGE_COLUMN]);
  });

  it("names that column bare, so a btree index can still serve the grouping", () => {
    const rendered = Render(GroupedBy("age").relation);
    expect(rendered).to.contain(`GROUP BY ${AGE_COLUMN}`);
    expect(rendered).to.not.contain("jsonb_build_object");
  });

  it("resolves _id through the row source, which the field list does not carry", () => {
    expect(TermTexts(GroupedBy("_id"))).to.deep.equal(['"t0"."_id"']);
  });

  it("spells the group value in the select list as the term itself", () => {
    const grouped = GroupedBy("age");
    expect(SelectedValue(grouped)).to.equal(OneTerm(grouped).sql);
  });

  it("spells the same term inside a mapper's document of members", () => {
    const grouped = ApplySubqueries(
      Root().group("age", (stream, group) => ({
        key: group,
        rows: stream.count(),
      })),
    );
    expect(SelectedValue(grouped)).to.contain(OneTerm(grouped).sql);
  });

  it("yields many rows rather than one, and blocks what reads an aggregate", () => {
    const { relation } = GroupedBy("age");
    expect(relation.aggregated).to.equal(true);
    expect(relation.single).to.equal(false);
  });

  it("names itself when the stage carries no index to group on", () => {
    expect(() => ApplyRaw([QueryStage("group", {})])).to.throw(
      "The 'group' stage is missing the index or field to group on",
    );
  });

  it("binds no parameter for a mapper that reads the group alone", () => {
    expect(GroupedBy("age").context.params.all()).to.deep.equal([]);
  });
});

describe("a group on a compound index", () => {
  it("groups by every column the index declares, in its own order", () => {
    expect(TermTexts(GroupedBy(COMPOUND_INDEX))).to.deep.equal([
      NAME_COLUMN,
      AGE_COLUMN,
    ]);
  });

  it("hands the mapper a document keyed by the index's own fields", () => {
    expect(SelectedValue(GroupedBy(COMPOUND_INDEX))).to.equal(
      `(jsonb_strip_nulls(jsonb_build_object('name', ${NAME_COLUMN},` +
        ` 'age', ${AGE_COLUMN})))`,
    );
  });

  it("names in that document exactly the columns it grouped by", () => {
    const grouped = GroupedBy(COMPOUND_INDEX);
    for (const term of TermTexts(grouped)) {
      expect(SelectedValue(grouped)).to.contain(term);
    }
  });

  it("builds it through the shared builder, so a container member keeps its nulls", () => {
    const grouped = GroupedBy(CONTAINER_INDEX);
    expect(TermTexts(grouped)).to.deep.equal([NAME_COLUMN, SKILLS_KEY]);
    expect(SelectedValue(grouped)).to.contain(
      `(CASE WHEN ${SKILLS_KEY} IS NULL THEN '{}'::jsonb`,
    );
  });

  it("types the group value as the document it built", () => {
    expect(GroupedBy(COMPOUND_INDEX).relation.projection?.type.kind).to.equal(
      "json",
    );
  });
});

describe("the type a group value keeps", () => {
  it("leaves a boolean field a boolean rather than a rendering of one", () => {
    expect(GroupedBy("isActive").relation.projection?.type).to.deep.equal(BOOL);
  });

  it("reads it into a mapper's document as a jsonb boolean", () => {
    const grouped = ApplySubqueries(
      Root().group("isActive", (stream, group) => ({
        paid: group,
        total: stream.sum("age"),
      })),
    );
    expect(SelectedValue(grouped)).to.contain(`to_jsonb(${ACTIVE_COLUMN})`);
    expect(SelectedValue(grouped)).to.not.contain("::text");
  });
});

describe("what a group wraps", () => {
  it("wraps an existing ordering inside, since 42803 refuses it beside a GROUP BY", () => {
    const { relation } = ApplySubqueries(
      Root()
        .orderBy("name", "asc")
        .group("age", (_stream, group) => group),
    );
    expect(relation.alias).to.equal(WRAPPED_ALIAS);
    expect(relation.from).to.contain(`ORDER BY ${NAME_COLUMN} ASC`);
    expect(relation.orderBy).to.deep.equal([]);
    expect(Render(relation)).to.contain(`GROUP BY "${WRAPPED_ALIAS}"."age"`);
  });

  it("is wrapped by an ordering that follows it, which orders the groups", () => {
    const { relation } = ApplySubqueries(
      Root()
        .group("age", (_stream, group) => group)
        .orderBy("name", "asc"),
    );
    expect(relation.alias).to.equal(WRAPPED_ALIAS);
    expect(relation.from).to.contain(`GROUP BY ${AGE_COLUMN}`);
    expect(relation.groupBy).to.deep.equal([]);
  });

  it("is wrapped by a count that follows it, which counts the groups", () => {
    const { relation } = ApplySubqueries(
      Root()
        .group("age", (_stream, group) => group)
        .count(),
    );
    expect(relation.from).to.contain(`GROUP BY ${AGE_COLUMN}`);
    expect(Render(relation)).to.contain("count(*)");
  });

  it("refuses a write after it, the relation no longer knowing a table", () => {
    expect(() => Write(Deleting())).to.throw(NO_ORIGIN);
  });
});

describe("a group whose mapper binds several sub-streams", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    const grouped = ApplySubqueries(
      Root().group("age", (stream, group) => ({
        key: group,
        total: stream.map((row) => row.key("age").default(0)).sum(),
        names: stream.distinct("name"),
        oldest: stream.map((row) => row.key("age").default(1)).max(),
      })),
    );
    const ledger = ReadParamLedger(grouped);
    expect(ledger.bound).to.not.deep.equal([]);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });
});
