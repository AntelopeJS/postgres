import { expect } from "chai";

import { VALIDATED } from "./config-fixture";
import { SetOptions } from "../../config";

/** @type {readonly unknown[]} */
const REFUSED = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
  1e21,
  "100",
  null,
  {},
];

describe("SetOptions", () => {
  for (const option of VALIDATED) {
    it(`refuses a ${option} that is not a positive safe integer`, () => {
      for (const value of REFUSED) {
        const options = {};
        options[option] = value;
        expect(() => SetOptions(options)).to.throw(option);
        expect(() => SetOptions(options)).to.throw(String(value));
      }
    });
  }

  it("refuses a mode it does not know", () => {
    expect(() => SetOptions({ mode: "readonly" })).to.throw("readonly");
  });
});
