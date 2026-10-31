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
    // @ts-expect-error CROSS_INSTANCE as the id, which NormalizeInstanceId refuses by naming the operation
    const stage = QueryStage("destroyInstance", { id: CROSS_INSTANCE });
    expect(() => NormalizeInstanceId("destroyInstance", stage)).to.throw(
      /destroyInstance/,
    );
    expect(() => NormalizeInstanceId("destroyInstance", stage)).to.throw(
      /CROSS_INSTANCE/,
    );
  });

  it("rejects a non-string id", () => {
    expect(() =>
      NormalizeInstanceId(
        "createInstance",
        // @ts-expect-error a number id, which NormalizeInstanceId refuses by naming its type
        QueryStage("createInstance", { id: 7 }),
      ),
    ).to.throw(/number/);
  });
});
