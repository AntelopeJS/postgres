import { expect } from "chai";
import { Info } from "@antelopejs/interface-database-catalog";

describe("the catalog of an owned instance", () => {
  it("refuses, since the instance owns its tables", async () => {
    try {
      await Info();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.match(/owns its tables/);
      return;
    }
    throw new Error("Info was expected to refuse");
  });
});
