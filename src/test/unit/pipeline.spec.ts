import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import {
  ApplyStages,
  DEFERRED_STAGES,
  REJECTED_STAGES,
} from "../../implementations/database/pipeline";
import {
  Apply,
  NewContext,
  NewTable,
  REJECTED_STAGE,
  WithDeferral,
} from "./pipeline-fold-fixture";

describe("ApplyStages", () => {
  it("folds nothing over an empty stage list", () => {
    const relation = NewTable();
    expect(ApplyStages(relation, [], NewContext())).to.equal(relation);
  });

  it("defers nothing, now that every stage is dispatched or declined", () => {
    expect(Object.keys(DEFERRED_STAGES)).to.deep.equal([]);
  });

  it("declines a change feed that reached the fold, which is one not last or one awaited", () => {
    expect(() => Apply(QueryStage(REJECTED_STAGE))).to.throw(
      "must be the last stage of a query and must be iterated rather than awaited",
    );
  });

  it("prefers the permanent rejection to a deferral of the same name", () => {
    WithDeferral(REJECTED_STAGE, () => {
      expect(() => Apply(QueryStage(REJECTED_STAGE))).to.throw(
        REJECTED_STAGES[REJECTED_STAGE],
      );
    });
  });
});
