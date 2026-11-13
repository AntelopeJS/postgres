import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import {
  ROW_ID,
  NewContext,
  Compile,
  Guarded,
} from "./expression-array-fixture";

describe("arr_count and arr_empty", () => {
  it("reads a scalar operand as jsonb so the guard nulls it", () => {
    const age = `to_jsonb("t"."age")`;
    expect(Compile((doc) => doc.key("age").count()).sql).to.equal(
      Guarded(age, `((jsonb_array_length(${age}))::double precision)`),
    );
  });
});

describe("arr_index", () => {
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
  it("names the stage when the start is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_slice")],
        NewContext(),
      ),
    ).to.throw(/'arr_slice'/);
  });
});
