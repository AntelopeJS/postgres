import { expect } from "chai";

import { CallerRoot, Write } from "./pipeline-fixture";

const KEY = "k";
const NAME = "a";

describe("the replace statement's refusals", () => {
  it("refuses a payload that is not a document, naming the stage", () => {
    expect(() => Write(CallerRoot().get(KEY).replace(NAME))).to.throw(
      "The 'replace' stage takes a document, received text",
    );
  });
});
