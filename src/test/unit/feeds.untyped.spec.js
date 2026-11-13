import assert from "node:assert";
import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { Feed, Reader, Step } from "./feeds-fixture";

describe("a change feed's refusals", () => {
  it("keeps the fold's own wording for a stage nothing knows, which is a typo", async () => {
    const { read } = Reader([{}]);
    await Feed(async (reqId) => {
      await Step(reqId, read, QueryStage("filtr")).then(
        () => expect.fail("no such stage"),
        (/** @type {unknown} */ err) => {
          assert(err instanceof Error, "the feed rejects with an Error");
          expect(err.message).to.contain("Unsupported query stage 'filtr'");
          expect(err.message).to.not.contain("'changes'");
        },
      );
    });
  });
});
