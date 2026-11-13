import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import { ROW_ID, NewContext } from "./expression-array-fixture";

describe("arr_map", () => {
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
  it("names the stage when the callback is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("arr_filter")],
        NewContext(),
      ),
    ).to.throw(/'arr_filter'/);
  });
});
