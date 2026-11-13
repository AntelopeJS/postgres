import { expect } from "chai";

import { Update } from "./writes-update-fixture";

describe("the update statement", () => {
  it("refuses a payload that is not a document, naming the stage", () => {
    expect(() => Update("a")).to.throw(
      "The 'update' stage takes a document, received text",
    );
  });

  it("refuses an array rather than writing its indices as keys", () => {
    expect(() => Update([])).to.throw(
      "The 'update' stage takes a document, received list",
    );
  });
});
