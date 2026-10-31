import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";

import {
  CompileExpression,
  STAGES,
} from "../../implementations/database/expression";

import {
  ArrayOf,
  BOOL,
  FLOAT,
  OPAQUE,
  TEXT,
} from "../../implementations/database/types";
import {
  ROW_ID,
  type Builder,
  NewContext,
  Compile,
  TAGS,
  EXTRA,
  Guarded,
  AsText,
  Element,
  Walk,
  Collected,
  FLOAT_PARAM,
} from "./expression-array-fixture";

function LastStage(build: Builder): QueryStage {
  const stages = build(ValueProxy.arg(ROW_ID)).build();
  return stages[stages.length - 1];
}

function Position(param: string): string {
  return `(LEAST(GREATEST(trunc(${param}), -2147483648), 2147483647)::int)`;
}

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
      (doc) => doc.key("tags").map((tag) => tag.upcase()),
      (doc) => doc.key("tags").filter((tag) => tag.eq("x")),
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
    expect(
      // @ts-expect-error a number column where count reads an array; the SQL guards jsonb_array_length of the column read through to_jsonb
      Compile((doc) => doc.key("age").count()).sql,
    ).to.equal(
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

  it("leaves a negative subscript to the arrow, which counts from the end itself", () => {
    const out = Compile((doc) => doc.key("tags").index(-1));
    const item = `(${TAGS} -> ${Position(FLOAT_PARAM)})`;
    expect(out.sql).to.equal(Guarded(TAGS, AsText(item)));
    expect(out.sql).to.not.contain("jsonb_array_length");
  });

  it("clamps the subscript to the int4 range instead of raising 22003", () => {
    const out = Compile((doc) => doc.key("nope").index(3e9));
    expect(out.sql).to.contain("LEAST(GREATEST(trunc(");
    expect(out.sql).to.contain("-2147483648), 2147483647)::int)");
  });

  it("names the stage when the position is absent", () => {
    expect(() =>
      CompileExpression(
        // @ts-expect-error no position, which the arr_index stage refuses by naming itself
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
    expect(
      Compile((doc) => doc.key("nope").includes([[1]])).sql,
    ).to.not.contain("CASE");
  });

  it("leaves a non-array operand to answer false, since @> cannot raise", () => {
    const age = `to_jsonb("t"."age")`;
    expect(
      // @ts-expect-error a number column where includes reads an array; the SQL is an unguarded @> of the column read through to_jsonb
      Compile((doc) => doc.key("age").includes("x")).sql,
    ).to.equal(`(${age} @> jsonb_build_array(to_jsonb(($1::text))))`);
  });

  it("names the stage when the value is absent", () => {
    expect(() =>
      CompileExpression(
        // @ts-expect-error no value, which the arr_includes stage refuses by naming itself
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_includes")],
        NewContext(),
      ),
    ).to.throw(/'arr_includes'/);
  });
});

/**
 * The bound as the walk compares it: counted from the end when it is negative.
 *
 * Transcribed rather than derived, exactly as every other expectation here. The operand is spelled
 * inside it because the length it counts back from is read off the same value the walk elements
 * come from, which is what makes `slice(-3)` mean the last three.
 */
function FromEnd(operand: string, bound: string): string {
  const counted = `GREATEST(jsonb_array_length(${operand}) + trunc(${bound}), 0)`;
  return `(CASE WHEN trunc(${bound}) < 0 THEN ${counted} ELSE trunc(${bound}) END)`;
}

describe("arr_slice", () => {
  it("translates zero-based end-exclusive bounds onto one-based ordinality", () => {
    const out = Compile((doc) => doc.key("tags").slice(1, 3));
    const low = FromEnd(TAGS, FLOAT_PARAM);
    const high = FromEnd(TAGS, SECOND_FLOAT_PARAM);
    const bounds = ` WHERE ("t0"."ord" > ${low} AND "t0"."ord" <= ${high})`;
    const body = Walk(TAGS, "t0", Collected("t0", Element("t0")), bounds);
    expect(out.sql).to.equal(Guarded(TAGS, body));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("omits the upper bound when no end is given", () => {
    const out = Compile((doc) => doc.key("tags").slice(1));
    const bounds = ` WHERE ("t0"."ord" > ${FromEnd(TAGS, FLOAT_PARAM)})`;
    expect(out.sql).to.equal(
      Guarded(TAGS, Walk(TAGS, "t0", Collected("t0", Element("t0")), bounds)),
    );
  });

  it("counts a negative bound back from the array's own length", () => {
    const out = Compile((doc) => doc.key("tags").slice(-3));
    expect(out.sql).to.contain(`"t0"."ord" > ${FromEnd(TAGS, FLOAT_PARAM)}`);
    expect(out.sql).to.contain(`jsonb_array_length(${TAGS})`);
  });

  it("floors a bound reaching past the start at the first element", () => {
    expect(Compile((doc) => doc.key("tags").slice(-9)).sql).to.contain(
      "GREATEST(",
    );
  });

  it("reads the length of the very value it walks, undeclared key and all", () => {
    const out = Compile((doc) => doc.key("nope").slice(-1));
    expect(out.sql).to.contain(`jsonb_array_length(${EXTRA})`);
  });

  it("coalesces an empty result to an empty array rather than null", () => {
    expect(Compile((doc) => doc.key("tags").slice(0)).sql).to.contain(
      "COALESCE(jsonb_agg(",
    );
  });

  it("names the stage when the start is absent", () => {
    expect(() =>
      CompileExpression(
        // @ts-expect-error no start, which the arr_slice stage refuses by naming itself
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
  { items: ["a", "b", "c"], start: -3 },
  { items: ["a", "b", "c"], start: -1 },
  { items: ["a", "b", "c"], start: -9 },
  { items: ["a", "b", "c"], start: 0, end: -1 },
  { items: ["a", "b", "c"], start: 1, end: -1 },
  { items: ["a", "b", "c"], start: -2, end: -1 },
  { items: ["a", "b", "c"], start: -1, end: -2 },
  { items: ["a", "b", "c"], start: 0, end: -9 },
  { items: ["a", "b", "c"], start: -1.5 },
  { items: [], start: -1 },
];

/** The bound the walk compares against, which is `GREATEST(len + s, 0)` below the origin. */
function Translated(bound: number, length: number): number {
  const truncated = Math.trunc(bound);
  return truncated < 0 ? Math.max(length + truncated, 0) : truncated;
}

function KeptByOrdinality(bounds: SliceBounds): string[] {
  const length = bounds.items.length;
  const start = Translated(bounds.start, length);
  return bounds.items.filter((_, index) => {
    const ordinal = index + 1;
    const end = bounds.end;
    const beforeEnd = end === undefined || ordinal <= Translated(end, length);
    return ordinal > start && beforeEnd;
  });
}

function Described(bounds: SliceBounds): string {
  return `${JSON.stringify(bounds.items)}.slice(${bounds.start}, ${bounds.end})`;
}

describe("arr_slice boundaries", () => {
  it("emits the very predicate the boundary cases below are checked against", () => {
    const out = Compile((doc) => doc.key("tags").slice(1, 3));
    const low = FromEnd(TAGS, FLOAT_PARAM);
    const high = FromEnd(TAGS, SECOND_FLOAT_PARAM);
    expect(out.sql).to.contain(
      ` WHERE ("t0"."ord" > ${low} AND "t0"."ord" <= ${high})`,
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
