import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { RecordedLambda } from "../../implementations/database/value";

describe("RecordedLambda", () => {
  it("accepts the text parameter ids of a func rebuilt from JSON", () => {
    const stage = QueryStage(
      "filter",
      undefined,
      QueryStage("func", undefined, ["a"], true),
    );
    expect(RecordedLambda(stage, 0).args[0]).to.deep.equal(["a"]);
  });
});
