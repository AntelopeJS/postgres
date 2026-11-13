import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import { ROW_ID, NewContext } from "./expression-fixture";

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
});

describe("arg", () => {
  it("reads a text parameter id as unbound rather than refusing it", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, "valueOf")],
        NewContext(),
      ),
    ).to.throw("Unbound lambda parameter valueOf");
  });

  it("reads an arg stage whose parameter id is neither a number nor a text as unbound", () => {
    expect(() =>
      CompileExpression([QueryStage("arg", undefined, true)], NewContext()),
    ).to.throw("Unbound lambda parameter true");
  });
});

describe("boolean stages", () => {
  it("rejects a missing operand naming the stage", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("and")],
        NewContext(),
      ),
    ).to.throw(/'and'/);
  });
});
