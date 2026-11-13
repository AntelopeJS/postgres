import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import { ROW_ID, NewContext } from "./expression-fixture";

describe("obj_merge", () => {
  it("names the stage when the other object is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("obj_merge")],
        NewContext(),
      ),
    ).to.throw(/'obj_merge'/);
  });
});

describe("obj_has", () => {
  it("names the stage when the field list is not a list", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("obj_has")],
        NewContext(),
      ),
    ).to.throw(/'obj_has'/);
  });

  it("names the stage when a field name is not a string", () => {
    expect(() =>
      CompileExpression(
        [
          QueryStage("arg", undefined, ROW_ID),
          QueryStage("obj_has", undefined, [5]),
        ],
        NewContext(),
      ),
    ).to.throw(/'obj_has'/);
  });
});
