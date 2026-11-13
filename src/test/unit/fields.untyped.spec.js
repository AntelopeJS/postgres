import { expect } from "chai";

import { ParseFieldType } from "../../implementations/database/fields";

describe("ParseFieldType", () => {
  it("rejects a declaration that is neither a string, array nor object", () => {
    expect(() => ParseFieldType(null, "t.f")).to.throw(
      /Unsupported field type/,
    );
    expect(() => ParseFieldType(123, "t.f")).to.throw(/Unsupported field type/);
    expect(() => ParseFieldType(undefined, "t.f")).to.throw(
      /Unsupported field type/,
    );
  });
});
