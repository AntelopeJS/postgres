import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import {
  CompileExpression,
  STAGES,
} from "../../implementations/database/expression";
import type { TableShape } from "../../implementations/database/fields";
import { ColumnRowSource } from "../../implementations/database/row-source";
import type { Compiled } from "../../implementations/database/sql";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import { Occurrences, RefusingCompilers } from "./spec-fixture";

const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;

const users: TableShape = {
  fields: {
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    tags: { column: "tags", type: ArrayOf(TEXT) },
    scores: { column: "scores", type: ArrayOf(FLOAT) },
    visits: { column: "visits", type: ArrayOf(TIMESTAMP) },
    entries: { column: "entries", type: ArrayOf(JsonOf({ at: TIMESTAMP })) },
    flags: { column: "flags", type: ArrayOf(BOOL) },
    nested: { column: "nested", type: ArrayOf(ArrayOf(FLOAT)) },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
  },
};

type Builder = (doc: any) => any;

function NewContext(): DecodingContext {
  const context = new DecodingContext({
    ...RefusingCompilers(),
    expression: CompileExpression,
  });
  context.bind(ROW_ID, new ColumnRowSource("t", users));
  return context;
}

function Compile(build: Builder): Compiled {
  return CompileExpression(build(ValueProxy.arg(ROW_ID)).build(), NewContext());
}

function LastStage(build: Builder): QueryStage {
  const stages = build(ValueProxy.arg(ROW_ID)).build();
  return stages[stages.length - 1];
}

const TAGS = `"t"."tags"`;
const SCORES = `"t"."scores"`;
const VISITS = `"t"."visits"`;
const ENTRIES = `"t"."entries"`;
const FLAGS = `"t"."flags"`;
const NESTED = `"t"."nested"`;
const NAME = `"t"."name"`;
const AGE = `"t"."age"`;
const EXTRA = `("t"."_extra" -> 'nope')`;

function Guarded(operand: string, body: string): string {
  return `(CASE WHEN jsonb_typeof(${operand}) = 'array' THEN ${body} END)`;
}

function AsText(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' THEN (${sql} #>> '{}') END)`;
}

function AsNumber(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'number' THEN ((${sql} #>> '{}')::double precision) END)`;
}

function AsMoment(sql: string): string {
  const parses = `pg_input_is_valid((${sql} #>> '{}'), 'timestamptz')`;
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' AND ${parses} THEN ((${sql} #>> '{}')::timestamptz) END)`;
}

function Element(alias: string): string {
  return `"${alias}"."value"`;
}

function Walk(
  operand: string,
  alias: string,
  aggregate: string,
  where = "",
): string {
  const columns = `AS "${alias}"("value", "ord")`;
  const source = `jsonb_array_elements(${operand}) WITH ORDINALITY ${columns}`;
  return `(SELECT ${aggregate} FROM ${source}${where})`;
}

function Collected(alias: string, target: string): string {
  return `COALESCE(jsonb_agg(${target} ORDER BY "${alias}"."ord"), '[]'::jsonb)`;
}

function GuardedObject(operand: string, body: string): string {
  return `(CASE WHEN jsonb_typeof(${operand}) = 'object' THEN ${body} END)`;
}

function Keys(operand: string, alias: string): string {
  const aggregate = Collected(alias, `"${alias}"."key"`);
  const columns = `AS "${alias}"("key", "ord")`;
  return `(SELECT ${aggregate} FROM jsonb_object_keys(${operand}) WITH ORDINALITY ${columns})`;
}

function Aliases(sql: string): string[] {
  return [...sql.matchAll(/AS "(t\d+)"/g)].map((match) => match[1]);
}

function Position(param: string): string {
  return `(LEAST(GREATEST(trunc(${param}), -2147483648), 2147483647)::int)`;
}

const FLOAT_PARAM = "($1::double precision)";
const SECOND_FLOAT_PARAM = "($2::double precision)";

const ARRAY_STAGE_NAMES = [
  "arr_index",
  "arr_includes",
  "arr_slice",
  "arr_map",
  "arr_filter",
  "arr_empty",
  "arr_count",
  "arr_sum",
  "arr_avg",
  "arr_min",
  "arr_max",
];

describe("array stage dispatch", () => {
  it("exposes every array stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members(ARRAY_STAGE_NAMES);
  });

  it("clears a pending timezone", () => {
    const builders: Builder[] = [
      (doc) => doc.key("tags").index(0),
      (doc) => doc.key("tags").includes("x"),
      (doc) => doc.key("tags").slice(1),
      (doc) => doc.key("tags").map((tag: any) => tag.upcase()),
      (doc) => doc.key("tags").filter((tag: any) => tag.eq("x")),
      (doc) => doc.key("tags").isempty(),
      (doc) => doc.key("tags").count(),
      (doc) => doc.key("scores").sum(),
      (doc) => doc.key("scores").avg(),
      (doc) => doc.key("scores").min(),
      (doc) => doc.key("scores").max(),
    ];
    for (const build of builders) {
      const stage = LastStage(build);
      const out = STAGES[stage.stage](
        { current: { sql: TAGS, type: ArrayOf(TEXT) }, timezone: "'UTC'" },
        stage,
        NewContext(),
      );
      expect(out.timezone, stage.stage).to.equal(undefined);
    }
  });
});

describe("arr_count and arr_empty", () => {
  it("measures a declared array column as a double precision length", () => {
    const out = Compile((doc) => doc.key("tags").count());
    expect(out.sql).to.equal(
      Guarded(TAGS, `((jsonb_array_length(${TAGS}))::double precision)`),
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("compares the length against zero rather than aggregating", () => {
    const out = Compile((doc) => doc.key("tags").isempty());
    expect(out.sql).to.equal(
      Guarded(TAGS, `(jsonb_array_length(${TAGS}) = 0)`),
    );
    expect(out.type).to.equal(BOOL);
  });

  it("guards an undeclared key, where the length of a non-array errors", () => {
    const out = Compile((doc) => doc.key("nope").count());
    expect(out.sql).to.equal(
      Guarded(EXTRA, `((jsonb_array_length(${EXTRA}))::double precision)`),
    );
  });

  it("reads a scalar operand as jsonb so the guard nulls it", () => {
    const age = `to_jsonb("t"."age")`;
    expect(Compile((doc) => doc.key("age").count()).sql).to.equal(
      Guarded(age, `((jsonb_array_length(${age}))::double precision)`),
    );
  });
});

describe("arr_index", () => {
  it("indexes with the zero-based jsonb arrow and reads the element type", () => {
    const out = Compile((doc) => doc.key("tags").index(0));
    const item = `(${TAGS} -> ${Position(FLOAT_PARAM)})`;
    expect(out.sql).to.equal(Guarded(TAGS, AsText(item)));
    expect(out.type).to.equal(TEXT);
  });

  it("keeps the bottom element type of an undeclared array as jsonb", () => {
    const out = Compile((doc) => doc.key("nope").index(1));
    const item = `(${EXTRA} -> ${Position(FLOAT_PARAM)})`;
    expect(out.sql).to.equal(Guarded(EXTRA, item));
    expect(out.type).to.deep.equal(OPAQUE);
  });

  it("clamps the subscript to the int4 range instead of raising 22003", () => {
    const out = Compile((doc) => doc.key("nope").index(3e9));
    expect(out.sql).to.contain("LEAST(GREATEST(trunc(");
    expect(out.sql).to.contain("-2147483648), 2147483647)::int)");
  });

  it("names the stage when the position is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_index")],
        NewContext(),
      ),
    ).to.throw(/'arr_index'/);
  });
});

describe("arr_includes", () => {
  it("tests containment with a single-element jsonb array", () => {
    const out = Compile((doc) => doc.key("tags").includes("x"));
    expect(out.sql).to.equal(
      `(${TAGS} @> jsonb_build_array(to_jsonb(($1::text))))`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("wraps the containment in no case, which a gin index cannot see through", () => {
    expect(Compile((doc) => doc.key("tags").includes("x")).sql).to.not.contain(
      "CASE",
    );
    expect(Compile((doc) => doc.key("nope").includes("x")).sql).to.not.contain(
      "CASE",
    );
  });

  it("leaves a non-array operand to answer false, since @> cannot raise", () => {
    const age = `to_jsonb("t"."age")`;
    expect(Compile((doc) => doc.key("age").includes("x")).sql).to.equal(
      `(${age} @> jsonb_build_array(to_jsonb(($1::text))))`,
    );
  });

  it("names the stage when the value is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_includes")],
        NewContext(),
      ),
    ).to.throw(/'arr_includes'/);
  });
});

describe("arr_slice", () => {
  it("translates zero-based end-exclusive bounds onto one-based ordinality", () => {
    const out = Compile((doc) => doc.key("tags").slice(1, 3));
    const bounds = ` WHERE ("t0"."ord" > ${FLOAT_PARAM} AND "t0"."ord" <= ${SECOND_FLOAT_PARAM})`;
    const body = Walk(TAGS, "t0", Collected("t0", Element("t0")), bounds);
    expect(out.sql).to.equal(Guarded(TAGS, body));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("omits the upper bound when no end is given", () => {
    const out = Compile((doc) => doc.key("tags").slice(1));
    const bounds = ` WHERE ("t0"."ord" > ${FLOAT_PARAM})`;
    expect(out.sql).to.equal(
      Guarded(TAGS, Walk(TAGS, "t0", Collected("t0", Element("t0")), bounds)),
    );
  });

  it("coalesces an empty result to an empty array rather than null", () => {
    expect(Compile((doc) => doc.key("tags").slice(0)).sql).to.contain(
      "COALESCE(jsonb_agg(",
    );
  });

  it("names the stage when the start is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_slice")],
        NewContext(),
      ),
    ).to.throw(/'arr_slice'/);
  });
});

interface SliceBounds {
  items: string[];
  start: number;
  end?: number;
}

const SLICE_BOUNDARIES: SliceBounds[] = [
  { items: ["a", "b", "c"], start: 0 },
  { items: ["a", "b", "c"], start: 0, end: 0 },
  { items: ["a", "b", "c"], start: 2, end: 2 },
  { items: ["a", "b", "c"], start: 1, end: 10 },
  { items: ["a"], start: 0, end: 1 },
  { items: ["a"], start: 0, end: 0 },
  { items: ["a", "b", "c"], start: 0.5, end: 2.5 },
  { items: ["a", "b", "c"], start: 1.5, end: 2.5 },
];

function KeptByOrdinality(bounds: SliceBounds): string[] {
  return bounds.items.filter((_, index) => {
    const ordinal = index + 1;
    const afterStart = ordinal > bounds.start;
    return afterStart && (bounds.end === undefined || ordinal <= bounds.end);
  });
}

function Described(bounds: SliceBounds): string {
  return `${JSON.stringify(bounds.items)}.slice(${bounds.start}, ${bounds.end})`;
}

describe("arr_slice boundaries", () => {
  it("emits the very predicate the boundary cases below are checked against", () => {
    const out = Compile((doc) => doc.key("tags").slice(1, 3));
    expect(out.sql).to.contain(
      ` WHERE ("t0"."ord" > ${FLOAT_PARAM} AND "t0"."ord" <= ${SECOND_FLOAT_PARAM})`,
    );
  });

  it("passes both bounds through as parameters, untruncated and in order", () => {
    const context = NewContext();
    CompileExpression(
      ValueProxy.arg<any>(ROW_ID).key("tags").slice(1.5, 2.5).build(),
      context,
    );
    expect(context.params.all()).to.deep.equal([1.5, 2.5]);
  });

  for (const bounds of SLICE_BOUNDARIES) {
    it(`agrees with ${Described(bounds)}`, () => {
      expect(KeptByOrdinality(bounds)).to.deep.equal(
        bounds.items.slice(bounds.start, bounds.end),
      );
    });
  }
});

describe("arr_map", () => {
  it("binds the element at its declared type, not as a jsonb round trip", () => {
    const out = Compile((doc) =>
      doc.key("tags").map((tag: any) => tag.upcase()),
    );
    const body = `(upper(${AsText(Element("t0"))}))`;
    const walk = Walk(TAGS, "t0", Collected("t0", `to_jsonb(${body})`));
    expect(out.sql).to.equal(Guarded(TAGS, walk));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("carries the body type into the result array type", () => {
    const out = Compile((doc) =>
      doc.key("tags").map((tag: any) => tag.strlen()),
    );
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("binds a bottom-typed element as raw jsonb", () => {
    const out = Compile((doc) => doc.key("nope").map((item: any) => item));
    const walk = Walk(EXTRA, "t0", Collected("t0", Element("t0")));
    expect(out.sql).to.equal(Guarded(EXTRA, walk));
    expect(out.type).to.deep.equal(ArrayOf(OPAQUE));
  });

  it("keeps a shaped element addressable as a row", () => {
    const out = Compile((doc) =>
      doc.key("entries").map((e: any) => e.key("at")),
    );
    const level = `(${Element("t0")} -> 'at')`;
    const walk = Walk(
      ENTRIES,
      "t0",
      Collected("t0", `to_jsonb(${AsMoment(level)})`),
    );
    expect(out.sql).to.equal(Guarded(ENTRIES, walk));
    expect(out.type).to.deep.equal(ArrayOf(TIMESTAMP));
  });

  it("gives two walks in one expression different aliases", () => {
    const out = Compile((doc) =>
      doc
        .key("tags")
        .map((tag: any) => tag.upcase())
        .eq(doc.key("tags").map((tag: any) => tag.downcase())),
    );
    expect(Aliases(out.sql)).to.deep.equal(["t0", "t1"]);
  });

  it("gives a nested walk an alias of its own", () => {
    const out = Compile((doc) =>
      doc.key("nope").map((item: any) => item.map((inner: any) => inner)),
    );
    expect(Aliases(out.sql)).to.deep.equal(["t1", "t0"]);
  });

  it("names the stage when the callback is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_map")],
        NewContext(),
      ),
    ).to.throw(/'arr_map'/);
  });
});

describe("arr_filter", () => {
  it("aggregates the untouched element under the predicate", () => {
    const out = Compile((doc) =>
      doc.key("scores").filter((score: any) => score.gt(2)),
    );
    const predicate = ` WHERE (${AsNumber(Element("t0"))} > ${FLOAT_PARAM})`;
    const walk = Walk(SCORES, "t0", Collected("t0", Element("t0")), predicate);
    expect(out.sql).to.equal(Guarded(SCORES, walk));
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("keeps the element type, unlike map, since nothing transforms it", () => {
    const out = Compile((doc) =>
      doc.key("tags").filter((tag: any) => tag.strlen().gt(2)),
    );
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("reads a non-boolean body as javascript truthiness", () => {
    const out = Compile((doc) =>
      doc.key("scores").filter((score: any) => score),
    );
    expect(out.sql).to.contain(`WHERE (${AsNumber(Element("t0"))} <> 0)`);
  });

  it("names the stage when the callback is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_filter")],
        NewContext(),
      ),
    ).to.throw(/'arr_filter'/);
  });
});

describe("a lambda body closing over the outer row", () => {
  it("reaches the row's own column from inside a map body", () => {
    const out = Compile((doc) =>
      doc.key("tags").map((tag: any) => tag.add(doc.key("name"))),
    );
    const body = `(${AsText(Element("t0"))} || ${NAME})`;
    const walk = Walk(TAGS, "t0", Collected("t0", `to_jsonb(${body})`));
    expect(out.sql).to.equal(Guarded(TAGS, walk));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("reaches the row's own column from inside a filter predicate", () => {
    const out = Compile((doc) =>
      doc.key("scores").filter((score: any) => score.gt(doc.key("age"))),
    );
    const predicate = ` WHERE (${AsNumber(Element("t0"))} > ${AGE})`;
    const walk = Walk(SCORES, "t0", Collected("t0", Element("t0")), predicate);
    expect(out.sql).to.equal(Guarded(SCORES, walk));
  });

  it("leaves the row addressable after the lambda has been decoded", () => {
    const out = Compile((doc) =>
      doc
        .key("tags")
        .map((tag: any) => tag.upcase())
        .count()
        .add(doc.key("age")),
    );
    expect(Occurrences(out.sql, AGE)).to.equal(1);
  });
});

describe("a walk whose body contains another walk", () => {
  it("nests an object walk inside a map and aliases it apart", () => {
    const out = Compile((doc) =>
      doc.key("entries").map((entry: any) => entry.keys()),
    );
    const body = GuardedObject(Element("t0"), Keys(Element("t0"), "t1"));
    const walk = Walk(ENTRIES, "t0", Collected("t0", body));
    expect(out.sql).to.equal(Guarded(ENTRIES, walk));
    expect(out.type).to.deep.equal(ArrayOf(ArrayOf(TEXT)));
  });

  it("aggregates inside a filter predicate", () => {
    const out = Compile((doc) =>
      doc.key("nested").filter((row: any) => row.count().gt(1)),
    );
    const length = `((jsonb_array_length(${Element("t0")}))::double precision)`;
    const counted = Guarded(Element("t0"), length);
    const predicate = ` WHERE (${counted} > ${FLOAT_PARAM})`;
    const walk = Walk(NESTED, "t0", Collected("t0", Element("t0")), predicate);
    expect(out.sql).to.equal(Guarded(NESTED, walk));
    expect(Aliases(out.sql)).to.deep.equal(["t0"]);
  });

  it("reduces inside a map body", () => {
    const out = Compile((doc) =>
      doc.key("nested").map((row: any) => row.sum()),
    );
    const summed = `COALESCE(sum(${AsNumber(Element("t1"))}), 0)`;
    const body = Guarded(Element("t0"), Walk(Element("t0"), "t1", summed));
    const walk = Walk(NESTED, "t0", Collected("t0", `to_jsonb(${body})`));
    expect(out.sql).to.equal(Guarded(NESTED, walk));
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("gives every level of a three-deep map an alias of its own", () => {
    const out = Compile((doc) =>
      doc
        .key("nope")
        .map((outer: any) =>
          outer.map((middle: any) => middle.map((inner: any) => inner)),
        ),
    );
    expect(Aliases(out.sql)).to.deep.equal(["t2", "t1", "t0"]);
    expect(out.type).to.deep.equal(ArrayOf(ArrayOf(ArrayOf(OPAQUE))));
  });
});

describe("array reducers", () => {
  it("sums an empty array to zero, which is what the contract documents", () => {
    const out = Compile((doc) => doc.key("scores").sum());
    const aggregate = `COALESCE(sum(${AsNumber(Element("t0"))}), 0)`;
    expect(out.sql).to.equal(Guarded(SCORES, Walk(SCORES, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("leaves the average of an empty array null", () => {
    const out = Compile((doc) => doc.key("scores").avg());
    const aggregate = `avg(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(SCORES, Walk(SCORES, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("compares a declared text array as text, since there is no min(jsonb)", () => {
    const out = Compile((doc) => doc.key("tags").min());
    const aggregate = `min(${AsText(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(TAGS, Walk(TAGS, "t0", aggregate)));
    expect(out.type).to.equal(TEXT);
  });

  it("compares a declared timestamp array as an instant", () => {
    const out = Compile((doc) => doc.key("visits").max());
    const aggregate = `max(${AsMoment(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(VISITS, Walk(VISITS, "t0", aggregate)));
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("defaults an unknown element type to a number comparison", () => {
    const out = Compile((doc) => doc.key("nope").min());
    const aggregate = `min(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(EXTRA, Walk(EXTRA, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("skips an element the guard nulls, so min of ['x', 1, null, 'y'] is 'x'", () => {
    const out = Compile((doc) => doc.key("tags").min());
    expect(out.sql).to.contain(`min(${AsText(Element("t0"))})`);
    expect(out.sql).to.not.contain("COALESCE");
  });

  it("reads a declared bool array as a number, so min of it is null", () => {
    const out = Compile((doc) => doc.key("flags").min());
    const aggregate = `min(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(FLAGS, Walk(FLAGS, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("reads a declared array of arrays as a number, so max of it is null", () => {
    const out = Compile((doc) => doc.key("nested").max());
    const aggregate = `max(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(NESTED, Walk(NESTED, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("reads shaped object elements as a number, so min of them is null", () => {
    const out = Compile((doc) => doc.key("entries").min());
    const aggregate = `min(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(ENTRIES, Walk(ENTRIES, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("orders every walk by ordinality rather than trusting jsonb_agg", () => {
    const out = Compile((doc) => doc.key("tags").slice(0));
    expect(out.sql).to.contain("WITH ORDINALITY");
    expect(out.sql).to.contain(`ORDER BY "t0"."ord"`);
  });
});

describe("array operand emission", () => {
  it("emits the operand twice for a guarded stage", () => {
    expect(
      Occurrences(Compile((doc) => doc.key("tags").count()).sql, TAGS),
    ).to.equal(2);
    expect(
      Occurrences(Compile((doc) => doc.key("tags").isempty()).sql, TAGS),
    ).to.equal(2);
    expect(
      Occurrences(Compile((doc) => doc.key("tags").slice(0)).sql, TAGS),
    ).to.equal(2);
    expect(
      Occurrences(Compile((doc) => doc.key("tags").min()).sql, TAGS),
    ).to.equal(2);
  });

  it("emits it once for the unguarded containment test", () => {
    expect(
      Occurrences(Compile((doc) => doc.key("tags").includes("x")).sql, TAGS),
    ).to.equal(1);
  });

  it("emits it three times when the element cast carries its own guard", () => {
    expect(
      Occurrences(Compile((doc) => doc.key("tags").index(0)).sql, TAGS),
    ).to.equal(3);
    expect(
      Occurrences(Compile((doc) => doc.key("nope").index(0)).sql, EXTRA),
    ).to.equal(2);
  });

  it("doubles the operand on every chained array stage", () => {
    const out = Compile((doc) =>
      doc
        .key("tags")
        .filter((tag: any) => tag.eq("x"))
        .count(),
    );
    expect(Occurrences(out.sql, TAGS)).to.equal(4);
  });
});
