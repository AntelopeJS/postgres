import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { ApplyRaw } from "./pipeline-fixture";

describe("the pluck stage", () => {
  it("rejects a field list that is not a list of names", () => {
    expect(() => ApplyRaw([QueryStage("pluck", undefined, [1])])).to.throw(
      "Stage 'pluck' requires a list of field names",
    );
  });
});

describe("the without stage", () => {
  it("rejects a field list that is not a list of names", () => {
    expect(() => ApplyRaw([QueryStage("without", undefined, [2])])).to.throw(
      "Stage 'without' requires a list of field names",
    );
  });
});
