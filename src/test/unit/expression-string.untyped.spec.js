import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import { ROW_ID, NewContext } from "./expression-fixture";

describe("string stage dispatch", () => {
  it("names the stage when the operand is absent", () => {
    for (const name of ["str_concat", "str_match"]) {
      expect(() =>
        CompileExpression(
          [QueryStage("arg", undefined, ROW_ID), QueryStage(name)],
          NewContext(),
        ),
      ).to.throw(`'${name}'`);
    }
  });
});
