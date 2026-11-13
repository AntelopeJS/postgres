import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";

import { CompileExpression } from "../../implementations/database/expression";
import { ROW_ID, NewContext } from "./expression-fixture";

describe("date_with_timezone", () => {
  it("names the stage when the zone is absent", () => {
    expect(() =>
      CompileExpression(
        [
          QueryStage("arg", undefined, ROW_ID),
          QueryStage("date_with_timezone"),
        ],
        NewContext(),
      ),
    ).to.throw(/'date_with_timezone'/);
  });

  it("names the stage when the zone is empty or is not a name", () => {
    const dynamic = ValueProxy.arg(ROW_ID).key("name");
    for (const zone of ["", 5, dynamic]) {
      expect(() =>
        CompileExpression(
          [
            QueryStage("arg", undefined, ROW_ID),
            QueryStage("date_with_timezone", undefined, zone),
          ],
          NewContext(),
        ),
      ).to.throw(/'date_with_timezone'/);
    }
  });
});

describe("date_during", () => {
  it("names the stage when a bound is absent", () => {
    expect(() =>
      CompileExpression(
        [
          QueryStage("arg", undefined, ROW_ID),
          QueryStage("date_during", undefined, new Date(0)),
        ],
        NewContext(),
      ),
    ).to.throw(/'date_during'/);
  });
});
