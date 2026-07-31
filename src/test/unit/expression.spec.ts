import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import {
  CompileExpression,
  STAGES,
} from "../../implementations/database/expression";
import type { TableShape } from "../../implementations/database/fields";
import {
  ColumnRowSource,
  JsonRowSource,
} from "../../implementations/database/row-source";
import type { Compiled } from "../../implementations/database/sql";
import {
  AsSource,
  AsValue,
  GuardJson,
  Lift,
  LiftRaw,
  Numeric,
  Predicate,
} from "../../implementations/database/stage";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;
const VALUE_ID = LAMBDA_ID_FLOOR - 2;
const SUBQUERY_ID = LAMBDA_ID_FLOOR - 3;

const users: TableShape = {
  fields: {
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    createdAt: { column: "createdAt", type: TIMESTAMP },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
  },
};

const ELEMENT: Compiled = { sql: 'e."value"', type: TEXT };
const SUBQUERY: Compiled = { sql: "(SELECT 1)", type: FLOAT };

type Builder = (doc: ValueProxy<any>) => ValueProxy<any>;

function NoSubqueries(): Compiled {
  throw new Error("Subqueries are not available in this spec");
}

function NewContext(): DecodingContext {
  const context = new DecodingContext(CompileExpression, NoSubqueries);
  context.bind(ROW_ID, new ColumnRowSource("t", users));
  context.bind(VALUE_ID, ELEMENT);
  context.bind(SUBQUERY_ID, () => SUBQUERY);
  return context;
}

function Compile(build: Builder): Compiled {
  return CompileExpression(build(ValueProxy.arg(ROW_ID)).build(), NewContext());
}

describe("CompileExpression dispatch", () => {
  it("rejects a stage it does not know", () => {
    expect(() =>
      CompileExpression([QueryStage("not_a_stage")], NewContext()),
    ).to.throw(/Unsupported expression stage 'not_a_stage'/);
  });

  it("does not dispatch a stage name inherited from Object.prototype", () => {
    expect(() =>
      CompileExpression([QueryStage("constructor")], NewContext()),
    ).to.throw(/Unsupported expression stage 'constructor'/);
    expect(() =>
      CompileExpression([QueryStage("__proto__")], NewContext()),
    ).to.throw(/Unsupported expression stage '__proto__'/);
  });

  it("rejects an expression that never produced a value", () => {
    expect(() => CompileExpression([], NewContext())).to.throw(
      /Expression has no value/,
    );
  });

  it("starts from the source it was handed", () => {
    const context = new DecodingContext(CompileExpression, NoSubqueries);
    const out = CompileExpression(
      ValueProxy.constant(1).build(),
      context,
      new ColumnRowSource("t", users),
    );
    expect(out.sql).to.equal("($1::double precision)");
  });

  it("exposes every core stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members([
      "arg",
      "constant",
      "default",
      "and",
      "or",
      "not",
      "eq",
      "ne",
      "cmp_gt",
      "cmp_ge",
      "cmp_lt",
      "cmp_le",
    ]);
  });
});

describe("arg", () => {
  it("keeps a bound row a row until a value is demanded", () => {
    const out = CompileExpression(ValueProxy.arg(ROW_ID).build(), NewContext());
    expect(out.sql).to.contain(`jsonb_strip_nulls(jsonb_build_object('_id'`);
    expect(out.type).to.deep.equal(
      JsonOf({
        _id: TEXT,
        age: FLOAT,
        name: TEXT,
        createdAt: TIMESTAMP,
        metadata: JsonOf({ level: FLOAT }),
      }),
    );
  });

  it("accepts a plain value binding", () => {
    const context = NewContext();
    const out = CompileExpression(
      ValueProxy.arg(VALUE_ID).eq("x").build(),
      context,
    );
    expect(out.sql).to.equal(`(e."value" = ($1::text))`);
    expect(out.type).to.equal(BOOL);
  });

  it("invokes a subquery provider binding", () => {
    const out = CompileExpression(
      ValueProxy.arg(SUBQUERY_ID).build(),
      NewContext(),
    );
    expect(out).to.equal(SUBQUERY);
  });

  it("rejects an unbound parameter", () => {
    expect(() =>
      CompileExpression(ValueProxy.arg(99).build(), NewContext()),
    ).to.throw(/Unbound lambda parameter 99/);
  });

  it("does not resolve a binding inherited from Object.prototype", () => {
    for (const key of ["valueOf", "constructor", "__proto__", "toString"]) {
      expect(() =>
        CompileExpression(ValueProxy.arg(key as never).build(), NewContext()),
      ).to.throw(`Unbound lambda parameter ${key}`);
    }
  });

  it("clears a pending timezone", () => {
    const out = STAGES.arg(
      { timezone: "'UTC'" },
      QueryStage("arg", undefined, VALUE_ID),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
    expect(out.current).to.equal(ELEMENT);
  });
});

describe("constant", () => {
  it("decodes an array through the shared value decoder", () => {
    const out = CompileExpression(
      ValueProxy.constant([1, 2]).build(),
      NewContext(),
    );
    expect(out.sql).to.equal(
      "jsonb_build_array(to_jsonb(($1::double precision)), to_jsonb(($2::double precision)))",
    );
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("names the stage when the value is absent", () => {
    expect(() =>
      CompileExpression(ValueProxy.constant(undefined).build(), NewContext()),
    ).to.throw(/'constant'/);
  });

  it("clears a pending timezone", () => {
    const out = STAGES.constant(
      { timezone: "'UTC'" },
      QueryStage("constant", undefined, 1),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
  });
});

describe("obj_index", () => {
  it("reaches a native column from a literal key", () => {
    const out = Compile((doc) => doc.key("age"));
    expect(out.sql).to.equal(`"t"."age"`);
    expect(out.type).to.equal(FLOAT);
  });

  it("falls to a dynamic lookup when the key is a value proxy", () => {
    const out = Compile((doc) =>
      doc.key("metadata").key(ValueProxy.constant("level") as never),
    );
    expect(out.sql).to.equal(`("t"."metadata" -> ($1::text))`);
    expect(out.type).to.equal(OPAQUE);
  });

  it("materializes the whole row for a dynamic key over a column source", () => {
    const out = Compile((doc) => doc.key(ValueProxy.constant("age") as never));
    expect(out.sql).to.contain("jsonb_strip_nulls(jsonb_build_object('_id'");
    expect(out.sql).to.contain(`-> ($1::text))`);
    expect(out.type).to.equal(OPAQUE);
  });

  it("applies a default to a dynamic key", () => {
    const out = Compile((doc) =>
      doc.key("metadata").key(ValueProxy.constant("level") as never, 0),
    );
    expect(out.sql).to.equal(
      `COALESCE((CASE WHEN jsonb_typeof(("t"."metadata" -> ($2::text))) = 'number' THEN ((("t"."metadata" -> ($2::text)) #>> '{}')::double precision) END), ($1::double precision))`,
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("clears a pending timezone", () => {
    const out = STAGES.obj_index(
      { current: new ColumnRowSource("t", users), timezone: "'UTC'" },
      QueryStage("obj_index", undefined, "age"),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
  });
});

describe("default", () => {
  it("coalesces a declared column against its fallback", () => {
    const out = Compile((doc) => doc.key("age").default(0));
    expect(out.sql).to.equal(`COALESCE("t"."age", ($1::double precision))`);
    expect(out.type).to.equal(FLOAT);
  });
});

describe("boolean stages", () => {
  it("joins two predicates with AND", () => {
    const out = Compile((doc) =>
      doc.key("age").gt(25).and(doc.key("age").lt(40)),
    );
    expect(out.sql).to.equal(
      `(("t"."age" > ($1::double precision)) AND ("t"."age" < ($2::double precision)))`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("joins two predicates with OR", () => {
    const out = Compile((doc) =>
      doc.key("age").gt(25).or(doc.key("age").lt(40)),
    );
    expect(out.sql).to.equal(
      `(("t"."age" > ($1::double precision)) OR ("t"."age" < ($2::double precision)))`,
    );
  });

  it("reads a numeric operand as javascript truthiness", () => {
    const out = Compile((doc) => doc.key("age").and(true));
    expect(out.sql).to.equal(`(("t"."age" <> 0) AND ($1::boolean))`);
    expect(out.type).to.equal(BOOL);
  });

  it("reads a text operand as javascript truthiness", () => {
    expect(Compile((doc) => doc.key("name").not()).sql).to.equal(
      `(NOT ("t"."name" <> ''))`,
    );
  });

  it("reads a timestamp operand as present or absent", () => {
    expect(Compile((doc) => doc.key("createdAt").not()).sql).to.equal(
      `(NOT ("t"."createdAt" IS NOT NULL))`,
    );
  });

  it("casts a jsonb operand to boolean under a typeof guard", () => {
    const out = Compile((doc) => doc.key("flagged").not());
    expect(out.sql).to.equal(
      `(NOT (CASE WHEN jsonb_typeof(("t"."_extra" -> 'flagged')) = 'boolean' THEN ((("t"."_extra" -> 'flagged') #>> '{}')::boolean) END))`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("rejects a missing operand naming the stage", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("and")],
        NewContext(),
      ),
    ).to.throw(/'and'/);
  });

  it("leaves a null operand null rather than reading it as false", () => {
    const guard = `(CASE WHEN jsonb_typeof(("t"."_extra" -> 'missing')) = 'boolean' THEN ((("t"."_extra" -> 'missing') #>> '{}')::boolean) END)`;
    expect(Compile((doc) => doc.key("missing").and(true)).sql).to.equal(
      `(${guard} AND ($1::boolean))`,
    );
    expect(Compile((doc) => doc.key("missing").or(true)).sql).to.equal(
      `(${guard} OR ($1::boolean))`,
    );
    expect(Compile((doc) => doc.key("missing").not()).sql).to.equal(
      `(NOT ${guard})`,
    );
  });
});

describe("Predicate", () => {
  it("reads a boolean unchanged", () => {
    expect(Predicate({ sql: "v", type: BOOL })).to.deep.equal({
      sql: "v",
      type: BOOL,
    });
  });

  it("compares a number against zero", () => {
    expect(Predicate({ sql: "v", type: FLOAT }).sql).to.equal("(v <> 0)");
  });

  it("compares text against the empty string", () => {
    expect(Predicate({ sql: "v", type: TEXT }).sql).to.equal("(v <> '')");
  });

  it("reads a timestamp as present or absent", () => {
    expect(Predicate({ sql: "v", type: TIMESTAMP }).sql).to.equal(
      "(v IS NOT NULL)",
    );
  });

  it("projects a json operand under the boolean guard", () => {
    const guarded =
      "(CASE WHEN jsonb_typeof(v) = 'boolean' THEN ((v #>> '{}')::boolean) END)";
    expect(Predicate({ sql: "v", type: OPAQUE }).sql).to.equal(guarded);
    expect(Predicate({ sql: "v", type: ArrayOf(TEXT) }).sql).to.equal(guarded);
  });

  it("types every reading as boolean", () => {
    for (const type of [BOOL, FLOAT, TEXT, TIMESTAMP, OPAQUE]) {
      expect(Predicate({ sql: "v", type }).type).to.equal(BOOL);
    }
  });
});

const NUMERIC_TEXT_PATTERN =
  "'^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$'";

describe("Numeric", () => {
  it("reads a number unchanged", () => {
    expect(Numeric({ sql: "v", type: FLOAT })).to.deep.equal({
      sql: "v",
      type: FLOAT,
    });
  });

  it("reads a boolean as one or zero, which is Number(true)", () => {
    expect(Numeric({ sql: "v", type: BOOL }).sql).to.equal(
      "((v)::int::double precision)",
    );
  });

  it("reads a timestamp as epoch milliseconds, which is Number(date)", () => {
    expect(Numeric({ sql: "v", type: TIMESTAMP }).sql).to.equal(
      "((EXTRACT(EPOCH FROM v) * 1000)::double precision)",
    );
  });

  it("guards the text cast with a regex, since Number('abc') is not an error", () => {
    expect(Numeric({ sql: "v", type: TEXT }).sql).to.equal(
      `(CASE WHEN v ~ ${NUMERIC_TEXT_PATTERN} THEN ((v)::double precision) END)`,
    );
  });

  it("projects a json operand under the number guard", () => {
    const guarded =
      "(CASE WHEN jsonb_typeof(v) = 'number' THEN ((v #>> '{}')::double precision) END)";
    expect(Numeric({ sql: "v", type: OPAQUE }).sql).to.equal(guarded);
    expect(Numeric({ sql: "v", type: ArrayOf(TEXT) }).sql).to.equal(guarded);
  });

  it("never emits a cast postgresql rejects at plan time", () => {
    for (const type of [BOOL, TIMESTAMP]) {
      expect(Numeric({ sql: "v", type }).sql).to.not.contain(
        "(v)::double precision",
      );
    }
  });

  it("types every reading as float", () => {
    for (const type of [BOOL, FLOAT, TEXT, TIMESTAMP, OPAQUE]) {
      expect(Numeric({ sql: "v", type }).type).to.equal(FLOAT);
    }
  });
});

describe("comparison stages", () => {
  it("compares a declared column without materializing the row", () => {
    const out = Compile((doc) => doc.key("age").gt(25));
    expect(out.sql).to.equal(`("t"."age" > ($1::double precision))`);
    expect(out.type).to.equal(BOOL);
    expect(out.sql).to.not.contain("jsonb_build_object");
    expect(out.sql).to.not.contain("jsonb");
  });

  it("maps each operator onto its SQL spelling", () => {
    expect(Compile((doc) => doc.key("age").eq(1)).sql).to.contain(
      `"t"."age" =`,
    );
    expect(Compile((doc) => doc.key("age").ne(1)).sql).to.contain(
      `"t"."age" <>`,
    );
    expect(Compile((doc) => doc.key("age").gt(1)).sql).to.contain(
      `"t"."age" >`,
    );
    expect(Compile((doc) => doc.key("age").ge(1)).sql).to.contain(
      `"t"."age" >=`,
    );
    expect(Compile((doc) => doc.key("age").lt(1)).sql).to.contain(
      `"t"."age" <`,
    );
    expect(Compile((doc) => doc.key("age").le(1)).sql).to.contain(
      `"t"."age" <=`,
    );
  });

  it("pulls an undeclared key toward the concrete operand", () => {
    const out = Compile((doc) => doc.key("nope").eq("x"));
    expect(out.sql).to.equal(
      `((CASE WHEN jsonb_typeof(("t"."_extra" -> 'nope')) = 'string' THEN (("t"."_extra" -> 'nope') #>> '{}') END) = ($1::text))`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("guards an undeclared key compared against a number", () => {
    const out = Compile((doc) => doc.key("nope").eq(3));
    expect(out.sql).to.equal(
      `((CASE WHEN jsonb_typeof(("t"."_extra" -> 'nope')) = 'number' THEN ((("t"."_extra" -> 'nope') #>> '{}')::double precision) END) = ($1::double precision))`,
    );
  });

  it("keeps a timestamp column native", () => {
    const out = Compile((doc) =>
      doc.key("createdAt").lt(new Date("2023-01-15T00:00:00Z")),
    );
    expect(out.sql).to.equal(`("t"."createdAt" < ($1::timestamptz))`);
  });

  it("under-matches ne on a heterogeneous undeclared key", () => {
    const out = Compile((doc) => doc.key("k").ne(5));
    expect(out.sql).to.equal(
      `((CASE WHEN jsonb_typeof(("t"."_extra" -> 'k')) = 'number' THEN ((("t"."_extra" -> 'k') #>> '{}')::double precision) END) <> ($1::double precision))`,
    );
  });

  it("drops a row whose compared field is missing", () => {
    const out = Compile((doc) => doc.key("missing").eq("x"));
    expect(out.sql).to.equal(
      `((CASE WHEN jsonb_typeof(("t"."_extra" -> 'missing')) = 'string' THEN (("t"."_extra" -> 'missing') #>> '{}') END) = ($1::text))`,
    );
  });

  it("keeps a nested shape through a chained key", () => {
    const out = Compile((doc) => doc.key("metadata").key("level").ge(3));
    expect(out.sql).to.equal(
      `((CASE WHEN jsonb_typeof(("t"."metadata" -> 'level')) = 'number' THEN ((("t"."metadata" -> 'level') #>> '{}')::double precision) END) >= ($1::double precision))`,
    );
    expect(out.sql).to.not.contain("jsonb_build_object");
  });
});

describe("null comparisons", () => {
  it("tests a declared column for SQL NULL", () => {
    const out = Compile((doc) => doc.key("age").eq(null));
    expect(out.sql).to.equal(`("t"."age" IS NULL)`);
    expect(out.type).to.equal(BOOL);
  });

  it("negates the same test for ne", () => {
    expect(Compile((doc) => doc.key("age").ne(null)).sql).to.equal(
      `(NOT ("t"."age" IS NULL))`,
    );
  });

  it("matches a stored json null as well as a missing key", () => {
    const key = `("t"."_extra" -> 'nope')`;
    expect(Compile((doc) => doc.key("nope").eq(null)).sql).to.equal(
      `((${key} IS NULL) OR (${key} = 'null'::jsonb))`,
    );
    expect(Compile((doc) => doc.key("nope").ne(null)).sql).to.equal(
      `(NOT ((${key} IS NULL) OR (${key} = 'null'::jsonb)))`,
    );
  });

  it("recognises the null on either side", () => {
    const out = CompileExpression(
      ValueProxy.constant(null)
        .eq(ValueProxy.arg<any>(ROW_ID).key("age"))
        .build(),
      NewContext(),
    );
    expect(out.sql).to.equal(`("t"."age" IS NULL)`);
  });

  it("leaves the ordering operators comparing against the json null", () => {
    expect(Compile((doc) => doc.key("age").gt(null)).sql).to.equal(
      `("t"."age" > (CASE WHEN jsonb_typeof('null'::jsonb) = 'number' THEN (('null'::jsonb #>> '{}')::double precision) END))`,
    );
  });
});

describe("stage helpers", () => {
  it("materializes a row only when a value is required", () => {
    const source = new ColumnRowSource("t", users);
    expect(AsValue({ current: source }).sql).to.equal(source.toJson().sql);
    expect(AsSource({ current: source })).to.equal(source);
  });

  it("wraps a value in a json row source", () => {
    const value: Compiled = { sql: "v", type: JsonOf({ level: FLOAT }) };
    const source = AsSource({ current: value });
    expect(source).to.be.instanceOf(JsonRowSource);
    expect(AsValue({ current: value })).to.equal(value);
  });

  it("refuses to materialize an empty accumulator", () => {
    expect(() => AsValue({})).to.throw(/Expression has no value/);
    expect(() => AsSource({})).to.throw(/Expression has no value/);
  });

  it("clears a pending timezone once a value stage runs", () => {
    const handler = Lift((value) => value);
    const out = handler(
      { current: { sql: "v", type: TEXT }, timezone: "'UTC'" },
      QueryStage("noop"),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
    expect(out.current).to.deep.equal({ sql: "v", type: TEXT });
  });

  it("hands a lifted handler the decoding context", () => {
    const handler = Lift((_value, _args, _stage, context) => ({
      sql: context.nextAlias(),
      type: TEXT,
    }));
    const out = handler(
      { current: { sql: "v", type: TEXT } },
      QueryStage("noop"),
      NewContext(),
    );
    expect(out.current).to.deep.equal({ sql: "t0", type: TEXT });
  });

  it("decodes every argument of a lifted stage", () => {
    const context = NewContext();
    Lift((value) => value)(
      { current: { sql: "v", type: TEXT } },
      QueryStage("noop", undefined, "a", "b"),
      context,
    );
    expect(context.params.all()).to.deep.equal(["a", "b"]);
  });

  it("leaves the arguments of a raw stage undecoded", () => {
    const context = NewContext();
    const handler = LiftRaw((value, stage, inner) => ({
      sql: `${value.sql}:${stage.args.join(",")}:${inner.nextAlias()}`,
      type: TEXT,
    }));
    const out = handler(
      { current: { sql: "v", type: TEXT }, timezone: "'UTC'" },
      QueryStage("noop", undefined, "a", "b"),
      context,
    );
    expect(out.current).to.deep.equal({ sql: "v:a,b:t0", type: TEXT });
    expect(out.timezone).to.equal(undefined);
    expect(context.params.all()).to.deep.equal([]);
  });

  it("guards a container operation on the json type", () => {
    expect(GuardJson({ sql: "v", type: OPAQUE }, "array", "body")).to.equal(
      "(CASE WHEN jsonb_typeof(v) = 'array' THEN body END)",
    );
  });
});
