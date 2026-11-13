import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import { ROW_ID, NewContext, Compile } from "./expression-fixture";

const BINARY_STAGES = [
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "bit_and",
  "bit_or",
  "bit_xor",
  "bit_lshift",
  "bit_rshift",
];

describe("numeric stage dispatch", () => {
  it("names the stage when the second operand is absent", () => {
    for (const name of BINARY_STAGES) {
      expect(() =>
        CompileExpression(
          [QueryStage("arg", undefined, ROW_ID), QueryStage(name)],
          NewContext(),
        ),
      ).to.throw(`'${name}'`);
    }
  });
});

describe("add", () => {
  it("rejects two dates, naming the stage", () => {
    expect(() =>
      Compile((doc) => doc.key("createdAt").add(new Date())),
    ).to.throw(
      /Stage 'add' has no reading for a 'timestamp' and a 'timestamp'/,
    );
  });
});
