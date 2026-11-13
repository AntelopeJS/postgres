import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { REJECTED_STAGES } from "../../implementations/database/pipeline";
import {
  Apply,
  DEFERRAL,
  DEFERRED_STAGE,
  REJECTED_STAGE,
  WithDeferral,
} from "./pipeline-fold-fixture";

const INHERITED_STAGE = "constructor";

describe("ApplyStages", () => {
  it("declines a stage named after an inherited member", () => {
    expect(() => Apply(QueryStage(INHERITED_STAGE))).to.throw(
      `Unsupported query stage '${INHERITED_STAGE}'`,
    );
  });

  it("names the stage a deferred message belongs to", () => {
    WithDeferral(DEFERRED_STAGE, () => {
      expect(() => Apply(QueryStage(DEFERRED_STAGE))).to.throw(
        `${DEFERRAL} (stage '${DEFERRED_STAGE}')`,
      );
    });
  });

  it("fails on the first stage it cannot apply", () => {
    expect(() =>
      Apply(QueryStage(REJECTED_STAGE), QueryStage(DEFERRED_STAGE)),
    ).to.throw(REJECTED_STAGES[REJECTED_STAGE]);
  });
});
