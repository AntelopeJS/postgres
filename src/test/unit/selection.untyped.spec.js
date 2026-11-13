import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { WithOptions } from "./spec-fixture";
import { BuildRoot } from "../../implementations/database/selection";
import { Build, NewContext, Root, SCHEMA_ID } from "./selection-fixture";

describe("BuildRoot", () => {
  it("rejects an instance id that is neither a string nor the sentinel", () => {
    const query = Root(SCHEMA_ID, 7);
    expect(() => Build(query, NewContext())).to.throw(
      "An instance id must be a string or CROSS_INSTANCE, received number",
    );
  });

  it("rejects a prefix stage carrying no id", () => {
    const stages = Root().build();
    stages[0] = QueryStage("schema");
    expect(() =>
      WithOptions({}, () => BuildRoot(stages, NewContext())),
    ).to.throw("The 'schema' stage of a table query is missing its id");
  });
});
