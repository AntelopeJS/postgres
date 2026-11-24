import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

interface Document {
  _id: string;
  stage?: string;
  args?: unknown[];
}

interface Tables {
  records: Document;
}

const schema = new Schema<Tables>("update_document", {
  records: { fields: { stage: "string" }, indexes: {} },
});
const table = schema.instance("tenant").table("records");
const ID = "one";

describe("update given a document shaped like a recorded lambda", () => {
  beforeEach(async () => {
    await table.delete().run();
  });

  it("writes a document holding stage func and an args pair as a document", async () => {
    await table.insert({ _id: ID, stage: "before" }).run();
    await table
      .get(ID)
      .update({ stage: "func", args: [[1, 2], "x"] })
      .run();
    expect(await table.get(ID).run()).to.deep.include({
      stage: "func",
      args: [[1, 2], "x"],
    });
  });
});
