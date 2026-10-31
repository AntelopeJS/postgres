import assert from "node:assert";
import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";
import { Datum, Query, ValueProxy } from "@antelopejs/interface-database";

import { RefusingCompilers } from "./spec-fixture";

/** PostgreSQL's own limit on arguments to one function call, which is what the fold exists for. */
const ARGUMENT_CAP = 100;
import type { Compiled } from "../../implementations/database/sql";
import {
  AliasedColumns,
  ColumnRowSource,
} from "../../implementations/database/row-source";
import {
  type ArgumentBinding,
  DecodingContext,
} from "../../implementations/database/context";
import {
  DecodeFunction,
  DecodeValue,
  IsRecordedFunction,
  type RecordedFunction,
  WithBoundArguments,
} from "../../implementations/database/value";
import {
  ArrayOf,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const STUB_EXPRESSION: Compiled = { sql: "EXPR", type: OPAQUE };
const STUB_SUBQUERY: Compiled = { sql: "SUB", type: OPAQUE };

interface Recorded {
  expressions: QueryStage[][];
  subqueries: QueryStage[][];
  bindings: ArgumentBinding[];
}

function NewRecorded(): Recorded {
  return { expressions: [], subqueries: [], bindings: [] };
}

function NewContext(recorded: Recorded): DecodingContext {
  return new DecodingContext({
    ...RefusingCompilers(),
    expression: (stages, context) => {
      recorded.expressions.push(stages);
      if (stages[0]?.stage === "arg") {
        recorded.bindings.push(context.arg(String(stages[0].args[0])));
      }
      return STUB_EXPRESSION;
    },
    subquery: (stages) => {
      recorded.subqueries.push(stages);
      return STUB_SUBQUERY;
    },
  });
}

describe("DecodeValue", () => {
  it("leaves undefined absent", () => {
    expect(DecodeValue(undefined, NewContext(NewRecorded()))).to.equal(
      undefined,
    );
  });

  it("encodes null as a json null rather than SQL NULL", () => {
    const out = DecodeValue(null, NewContext(NewRecorded()));
    expect(out?.sql).to.equal("'null'::jsonb");
    expect(out?.type).to.equal(OPAQUE);
  });

  it("passes a Date through as a timestamptz parameter", () => {
    const context = NewContext(NewRecorded());
    const date = new Date("2003-01-01T00:00:00Z");
    const out = DecodeValue(date, context);
    expect(out?.sql).to.equal("($1::timestamptz)");
    expect(out?.type).to.equal(TIMESTAMP);
    expect(context.params.all()).to.deep.equal([date]);
    expect(context.params.all()[0]).to.equal(date);
  });

  it("maps primitives onto their physical types", () => {
    const context = NewContext(NewRecorded());
    expect(DecodeValue("x", context)?.sql).to.equal("($1::text)");
    expect(DecodeValue(12, context)?.sql).to.equal("($2::double precision)");
    expect(DecodeValue(true, context)?.sql).to.equal("($3::boolean)");
    expect(DecodeValue("x", context)?.type).to.equal(TEXT);
    expect(context.params.all()).to.deep.equal(["x", 12, true, "x"]);
  });

  it("rejects a value it cannot represent", () => {
    const context = NewContext(NewRecorded());
    expect(() => DecodeValue(() => 1, context)).to.throw(/function/);
  });

  it("dispatches a ValueProxy to the expression compiler", () => {
    const recorded = NewRecorded();
    const proxy = ValueProxy.constant(5);
    const out = DecodeValue(proxy, NewContext(recorded));
    expect(out).to.equal(STUB_EXPRESSION);
    expect(recorded.expressions).to.deep.equal([proxy.build()]);
    expect(recorded.subqueries).to.deep.equal([]);
  });

  it("dispatches a Query to the subquery compiler", () => {
    const recorded = NewRecorded();
    const query = new Query(QueryStage("table", { id: "vehicles" }));
    const out = DecodeValue(query, NewContext(recorded));
    expect(out).to.equal(STUB_SUBQUERY);
    expect(recorded.subqueries).to.deep.equal([query.build()]);
  });

  it("dispatches a Query subclass to the subquery compiler", () => {
    const recorded = NewRecorded();
    const datum = new Datum(QueryStage("table", { id: "vehicles" }));
    expect(DecodeValue(datum, NewContext(recorded))).to.equal(STUB_SUBQUERY);
    expect(recorded.expressions).to.deep.equal([]);
  });

  it("builds a jsonb object from a plain object", () => {
    const context = NewContext(NewRecorded());
    const out = DecodeValue({ a: 1 }, context);
    expect(out?.sql).to.equal(
      "jsonb_build_object('a', to_jsonb(($1::double precision)))",
    );
    expect(out?.type).to.deep.equal(JsonOf({ a: FLOAT }));
  });

  it("omits an undefined member from both the sql and the shape", () => {
    const context = NewContext(NewRecorded());
    const out = DecodeValue({ a: 1, b: undefined }, context);
    expect(out?.sql).to.equal(
      "jsonb_build_object('a', to_jsonb(($1::double precision)))",
    );
    expect(out?.type).to.deep.equal(JsonOf({ a: FLOAT }));
    expect(context.params.all()).to.deep.equal([1]);
  });

  it("keeps a nested Date as a timestamptz parameter, not a json string", () => {
    const context = NewContext(NewRecorded());
    const date = new Date("2003-01-01T00:00:00Z");
    const out = DecodeValue({ at: date }, context);
    expect(out?.sql).to.equal(
      "jsonb_build_object('at', to_jsonb(($1::timestamptz)))",
    );
    expect(out?.type).to.deep.equal(JsonOf({ at: TIMESTAMP }));
    expect(context.params.all()[0]).to.equal(date);
  });

  it("builds a jsonb array with a uniform element type", () => {
    const context = NewContext(NewRecorded());
    const out = DecodeValue([1, 2], context);
    expect(out?.sql).to.equal("($1::jsonb)");
    expect(context.params.all()).to.deep.equal(["[1,2]"]);
    expect(out?.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("joins a mixed array down to the bottom element type", () => {
    const context = NewContext(NewRecorded());
    const out = DecodeValue([1, "a", 2], context);
    expect(out?.type).to.deep.equal(ArrayOf(OPAQUE));
  });

  it("binds a list longer than postgresql's argument cap as one parameter", () => {
    const context = NewContext(NewRecorded());
    const values = Array.from({ length: ARGUMENT_CAP * 2 }, (_, i) => `k${i}`);
    const out = DecodeValue(values, context);
    expect(out?.sql).to.equal("($1::jsonb)");
    expect(context.params.all()).to.have.lengthOf(1);
    expect(out?.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("still compiles an element the row has to supply", () => {
    const context = NewContext(NewRecorded());
    const out = DecodeValue([1, ValueProxy.constant(2)], context);
    expect(out?.sql).to.contain("jsonb_build_array");
  });

  it("keeps a null array member as a json null", () => {
    const context = NewContext(NewRecorded());
    const out = DecodeValue([null], context);
    expect(out?.sql).to.equal("($1::jsonb)");
    expect(out?.type).to.deep.equal(ArrayOf(OPAQUE));
  });
});

function LambdaStage(func: QueryStage): RecordedFunction {
  assert(IsRecordedFunction(func), "the builder records a lambda this way");
  return func;
}

describe("DecodeFunction", () => {
  const emptyTable = { fields: {} };

  it("binds each lambda parameter for the duration of the decode", () => {
    const recorded = NewRecorded();
    const context = NewContext(recorded);
    const source = new ColumnRowSource(AliasedColumns("t"), emptyTable);
    const func = LambdaStage(
      QueryStage("func", undefined, [7], ValueProxy.arg(7)),
    );

    const out = DecodeFunction(func, context, [source]);

    expect(out).to.equal(STUB_EXPRESSION);
    expect(recorded.bindings).to.have.lengthOf(1);
    expect(recorded.bindings[0]).to.equal(source);
    expect(() => context.arg(7)).to.throw(/7/);
  });

  it("binds every declared parameter", () => {
    const recorded = NewRecorded();
    const context = NewContext(recorded);
    const left = new ColumnRowSource(AliasedColumns("l"), emptyTable);
    const right = new ColumnRowSource(AliasedColumns("r"), emptyTable);
    const func = LambdaStage(
      QueryStage(
        "func",
        undefined,
        [3, 4],
        [ValueProxy.arg(3), ValueProxy.arg(4)],
      ),
    );

    DecodeFunction(func, context, [left, right]);

    expect(recorded.bindings).to.deep.equal([left, right]);
    expect(() => context.arg(3)).to.throw(/3/);
    expect(() => context.arg(4)).to.throw(/4/);
  });

  it("rejects a lambda parameter with no binding", () => {
    const context = NewContext(NewRecorded());
    const func = LambdaStage(
      QueryStage("func", undefined, [7], ValueProxy.arg(7)),
    );
    expect(() => DecodeFunction(func, context, [])).to.throw(/Missing binding/);
  });

  it("binds nothing when a later parameter has no binding", () => {
    const context = NewContext(NewRecorded());
    const left = new ColumnRowSource(AliasedColumns("l"), emptyTable);
    const func = LambdaStage(
      QueryStage(
        "func",
        undefined,
        [3, 4],
        [ValueProxy.arg(3), ValueProxy.arg(4)],
      ),
    );

    expect(() => DecodeFunction(func, context, [left])).to.throw(
      /Missing binding/,
    );
    expect(() => context.arg(3)).to.throw(/3/);
    expect(() => context.arg(4)).to.throw(/4/);
  });

  it("unbinds even when the body fails to decode", () => {
    const context = NewContext(NewRecorded());
    const source = new ColumnRowSource(AliasedColumns("t"), emptyTable);
    const func = LambdaStage(QueryStage("func", undefined, [7], () => 1));

    expect(() => DecodeFunction(func, context, [source])).to.throw(/function/);
    expect(() => context.arg(7)).to.throw(/7/);
  });
});

describe("IsRecordedFunction", () => {
  it("does not take text parameter ids for a lambda where a document is allowed", () => {
    expect(IsRecordedFunction({ stage: "func", args: [["a"], true] })).to.equal(
      false,
    );
  });
});

describe("WithBoundArguments", () => {
  const emptyTable = { fields: {} };
  const REFUSED = "the compilation this spans refuses the body";

  it("unbinds even when a compilation that is not a decode throws", () => {
    const context = NewContext(NewRecorded());
    const source = new ColumnRowSource(AliasedColumns("t"), emptyTable);
    const func = LambdaStage(
      QueryStage("func", undefined, [7], ValueProxy.arg(7)),
    );

    expect(() =>
      WithBoundArguments(func, context, [source], () => {
        throw new Error(REFUSED);
      }),
    ).to.throw(REFUSED);
    expect(() => context.arg(7)).to.throw(/7/);
  });
});
