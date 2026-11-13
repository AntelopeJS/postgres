import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { ApplyRaw } from "./pipeline-fixture";

describe("the group stage", () => {
  it("names itself when the stage carries no index to group on", () => {
    expect(() => ApplyRaw([QueryStage("group", {})])).to.throw(
      "The 'group' stage is missing the index or field to group on",
    );
  });
});
