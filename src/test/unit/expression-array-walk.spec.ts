import { expect } from "chai";

import { QueryStage } from "@antelopejs/interface-database/common";

import { Occurrences } from "./spec-fixture";

import { CompileExpression } from "../../implementations/database/expression";

import {
  ArrayOf,
  FLOAT,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  ROW_ID,
  NewContext,
  Compile,
  CompileLoose,
  TAGS,
  EXTRA,
  Guarded,
  AsText,
  Element,
  Walk,
  Collected,
  FLOAT_PARAM,
} from "./expression-array-fixture";
import { UntypedStage } from "./invalid-fixture";

const SCORES = `"t"."scores"`;

const VISITS = `"t"."visits"`;

const ENTRIES = `"t"."entries"`;

const FLAGS = `"t"."flags"`;

const NESTED = `"t"."nested"`;

const NAME = `"t"."name"`;

const AGE = `"t"."age"`;

function AsNumber(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'number' THEN ((${sql} #>> '{}')::double precision) END)`;
}

function AsMoment(sql: string): string {
  const parses = `pg_input_is_valid((${sql} #>> '{}'), 'timestamptz')`;
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' AND ${parses} THEN ((${sql} #>> '{}')::timestamptz) END)`;
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

describe("arr_map", () => {
  it("binds the element at its declared type, not as a jsonb round trip", () => {
    const out = Compile((doc) => doc.key("tags").map((tag) => tag.upcase()));
    const body = `(upper(${AsText(Element("t0"))}))`;
    const walk = Walk(TAGS, "t0", Collected("t0", `to_jsonb(${body})`));
    expect(out.sql).to.equal(Guarded(TAGS, walk));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("carries the body type into the result array type", () => {
    const out = Compile((doc) => doc.key("tags").map((tag) => tag.strlen()));
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("binds a bottom-typed element as raw jsonb", () => {
    const out = Compile((doc) => doc.key("nope").map((item) => item));
    const walk = Walk(EXTRA, "t0", Collected("t0", Element("t0")));
    expect(out.sql).to.equal(Guarded(EXTRA, walk));
    expect(out.type).to.deep.equal(ArrayOf(OPAQUE));
  });

  it("keeps a shaped element addressable as a row", () => {
    const out = Compile((doc) => doc.key("entries").map((e) => e.key("at")));
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
        .map((tag) => tag.upcase())
        .eq(doc.key("tags").map((tag) => tag.downcase())),
    );
    expect(Aliases(out.sql)).to.deep.equal(["t0", "t1"]);
  });

  it("gives a nested walk an alias of its own", () => {
    const out = Compile((doc) =>
      doc.key("nope").map((item) => item.map((inner) => inner)),
    );
    expect(Aliases(out.sql)).to.deep.equal(["t1", "t0"]);
  });

  it("names the stage when the callback is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), UntypedStage("arr_map")],
        NewContext(),
      ),
    ).to.throw(/'arr_map'/);
  });
});

describe("arr_filter", () => {
  it("aggregates the untouched element under the predicate", () => {
    const out = Compile((doc) =>
      doc.key("scores").filter((score) => score.gt(2)),
    );
    const predicate = ` WHERE (${AsNumber(Element("t0"))} > ${FLOAT_PARAM})`;
    const walk = Walk(SCORES, "t0", Collected("t0", Element("t0")), predicate);
    expect(out.sql).to.equal(Guarded(SCORES, walk));
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("keeps the element type, unlike map, since nothing transforms it", () => {
    const out = Compile((doc) =>
      doc.key("tags").filter((tag) => tag.strlen().gt(2)),
    );
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("reads a non-boolean body as javascript truthiness", () => {
    const out = CompileLoose((doc: any) =>
      doc.key("scores").filter((score: any) => score),
    );
    expect(out.sql).to.contain(`WHERE (${AsNumber(Element("t0"))} <> 0)`);
  });

  it("names the stage when the callback is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), UntypedStage("arr_filter")],
        NewContext(),
      ),
    ).to.throw(/'arr_filter'/);
  });
});

describe("a lambda body closing over the outer row", () => {
  it("reaches the row's own column from inside a map body", () => {
    const out = CompileLoose((doc: any) =>
      doc.key("tags").map((tag: any) => tag.add(doc.key("name"))),
    );
    const body = `(${AsText(Element("t0"))} || ${NAME})`;
    const walk = Walk(TAGS, "t0", Collected("t0", `to_jsonb(${body})`));
    expect(out.sql).to.equal(Guarded(TAGS, walk));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("reaches the row's own column from inside a filter predicate", () => {
    const out = Compile((doc) =>
      doc.key("scores").filter((score) => score.gt(doc.key("age"))),
    );
    const predicate = ` WHERE (${AsNumber(Element("t0"))} > ${AGE})`;
    const walk = Walk(SCORES, "t0", Collected("t0", Element("t0")), predicate);
    expect(out.sql).to.equal(Guarded(SCORES, walk));
  });

  it("leaves the row addressable after the lambda has been decoded", () => {
    const out = Compile((doc) =>
      doc
        .key("tags")
        .map((tag) => tag.upcase())
        .count()
        .add(doc.key("age")),
    );
    expect(Occurrences(out.sql, AGE)).to.equal(1);
  });
});

describe("a walk whose body contains another walk", () => {
  it("nests an object walk inside a map and aliases it apart", () => {
    const out = Compile((doc) =>
      doc.key("entries").map((entry) => entry.keys()),
    );
    const body = GuardedObject(Element("t0"), Keys(Element("t0"), "t1"));
    const walk = Walk(ENTRIES, "t0", Collected("t0", body));
    expect(out.sql).to.equal(Guarded(ENTRIES, walk));
    expect(out.type).to.deep.equal(ArrayOf(ArrayOf(TEXT)));
  });

  it("aggregates inside a filter predicate", () => {
    const out = Compile((doc) =>
      doc.key("nested").filter((row) => row.count().gt(1)),
    );
    const length = `((jsonb_array_length(${Element("t0")}))::double precision)`;
    const counted = Guarded(Element("t0"), length);
    const predicate = ` WHERE (${counted} > ${FLOAT_PARAM})`;
    const walk = Walk(NESTED, "t0", Collected("t0", Element("t0")), predicate);
    expect(out.sql).to.equal(Guarded(NESTED, walk));
    expect(Aliases(out.sql)).to.deep.equal(["t0"]);
  });

  it("reduces inside a map body", () => {
    const out = Compile((doc) => doc.key("nested").map((row) => row.sum()));
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
        .map((outer) => outer.map((middle) => middle.map((inner) => inner))),
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
    const out = CompileLoose((doc: any) => doc.key("tags").min());
    const aggregate = `min(${AsText(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(TAGS, Walk(TAGS, "t0", aggregate)));
    expect(out.type).to.equal(TEXT);
  });

  it("compares a declared timestamp array as an instant", () => {
    const out = CompileLoose((doc: any) => doc.key("visits").max());
    const aggregate = `max(${AsMoment(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(VISITS, Walk(VISITS, "t0", aggregate)));
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("defaults an unknown element type to a number comparison", () => {
    const out = CompileLoose((doc: any) => doc.key("nope").min());
    const aggregate = `min(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(EXTRA, Walk(EXTRA, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("skips an element the guard nulls, so min of ['x', 1, null, 'y'] is 'x'", () => {
    const out = CompileLoose((doc: any) => doc.key("tags").min());
    expect(out.sql).to.contain(`min(${AsText(Element("t0"))})`);
    expect(out.sql).to.not.contain("COALESCE");
  });

  it("reads a declared bool array as a number, so min of it is null", () => {
    const out = CompileLoose((doc: any) => doc.key("flags").min());
    const aggregate = `min(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(FLAGS, Walk(FLAGS, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("reads a declared array of arrays as a number, so max of it is null", () => {
    const out = CompileLoose((doc: any) => doc.key("nested").max());
    const aggregate = `max(${AsNumber(Element("t0"))})`;
    expect(out.sql).to.equal(Guarded(NESTED, Walk(NESTED, "t0", aggregate)));
    expect(out.type).to.equal(FLOAT);
  });

  it("reads shaped object elements as a number, so min of them is null", () => {
    const out = CompileLoose((doc: any) => doc.key("entries").min());
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
      Occurrences(CompileLoose((doc: any) => doc.key("tags").min()).sql, TAGS),
    ).to.equal(2);
  });

  it("emits it once more per slice bound, which reads the length to count back", () => {
    expect(
      Occurrences(Compile((doc) => doc.key("tags").slice(0)).sql, TAGS),
    ).to.equal(3);
    expect(
      Occurrences(Compile((doc) => doc.key("tags").slice(0, 2)).sql, TAGS),
    ).to.equal(4);
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
        .filter((tag) => tag.eq("x"))
        .count(),
    );
    expect(Occurrences(out.sql, TAGS)).to.equal(4);
  });
});
