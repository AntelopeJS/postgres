import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { NormalizeInstanceId } from "../../implementations/database/utils";

describe("NormalizeInstanceId", () => {
  it("maps an absent id to the default instance", () => {
    expect(
      NormalizeInstanceId(
        "createInstance",
        QueryStage("createInstance", { id: undefined }),
      ),
    ).to.equal("");
    expect(
      NormalizeInstanceId(
        "createInstance",
        QueryStage("createInstance", { id: null }),
      ),
    ).to.equal("");
  });

  it("passes a named id through", () => {
    expect(
      NormalizeInstanceId(
        "createInstance",
        QueryStage("createInstance", { id: "alpha" }),
      ),
    ).to.equal("alpha");
  });

  it("rejects CROSS_INSTANCE, naming the operation", () => {
    expect(() =>
      NormalizeInstanceId(
        "destroyInstance",
        QueryStage("destroyInstance", { id: CROSS_INSTANCE }),
      ),
    ).to.throw(/destroyInstance/);
    expect(() =>
      NormalizeInstanceId(
        "destroyInstance",
        QueryStage("destroyInstance", { id: CROSS_INSTANCE }),
      ),
    ).to.throw(/CROSS_INSTANCE/);
  });

  it("rejects a non-string id", () => {
    expect(() =>
      NormalizeInstanceId(
        "createInstance",
        QueryStage("createInstance", { id: 7 }),
      ),
    ).to.throw(/number/);
  });
});
