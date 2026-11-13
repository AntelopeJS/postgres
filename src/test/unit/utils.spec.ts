import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { NormalizeInstanceId } from "../../implementations/database/utils";

describe("NormalizeInstanceId", () => {
  it("passes a named id through", () => {
    expect(
      NormalizeInstanceId(
        "createInstance",
        QueryStage("createInstance", { id: "alpha" }),
      ),
    ).to.equal("alpha");
  });
});
