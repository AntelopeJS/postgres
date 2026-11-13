import { expect } from "chai";

import { CallerRoot, Write } from "./pipeline-fixture";

describe("the insert statement's conflict modes", () => {
  it("refuses a conflict mode it does not know, naming the ones it does", () => {
    expect(() =>
      Write(CallerRoot().insert({ name: "a" }, { conflict: "ignore" })),
    ).to.throw(
      "The 'insert' stage takes a conflict mode of update or replace, received \"ignore\"",
    );
  });
});

describe("the ids an insert answers", () => {
  it("refuses an argument that is not a document", () => {
    expect(() => Write(CallerRoot().insert("a"))).to.throw(
      "The 'insert' stage takes documents, received text at position 0",
    );
  });

  it("refuses a nested array rather than storing its indices as keys", () => {
    expect(() => Write(CallerRoot().insert([[]]))).to.throw(
      "The 'insert' stage takes documents, received list at position 0",
    );
  });
});
