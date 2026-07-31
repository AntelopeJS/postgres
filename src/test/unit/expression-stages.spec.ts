import { expect } from "chai";
import { STAGES } from "../../implementations/database/expression";

const VOCABULARY: readonly string[] = [
  "add",
  "and",
  "arg",
  "arr_avg",
  "arr_count",
  "arr_empty",
  "arr_filter",
  "arr_includes",
  "arr_index",
  "arr_map",
  "arr_max",
  "arr_min",
  "arr_slice",
  "arr_sum",
  "bit_and",
  "bit_lshift",
  "bit_not",
  "bit_or",
  "bit_rshift",
  "bit_xor",
  "ceil",
  "cmp_ge",
  "cmp_gt",
  "cmp_le",
  "cmp_lt",
  "constant",
  "date_day",
  "date_dow",
  "date_doy",
  "date_during",
  "date_epoch",
  "date_hours",
  "date_minutes",
  "date_month",
  "date_seconds",
  "date_tod",
  "date_with_timezone",
  "date_year",
  "default",
  "div",
  "eq",
  "floor",
  "mod",
  "mul",
  "ne",
  "not",
  "obj_has",
  "obj_index",
  "obj_keys",
  "obj_merge",
  "obj_values",
  "or",
  "round",
  "str_concat",
  "str_downcase",
  "str_len",
  "str_match",
  "str_split",
  "str_upcase",
  "sub",
];

const STAGE_COUNT = 60;

describe("the stage vocabulary", () => {
  it("dispatches exactly the stages ValueProxy records, and no others", () => {
    expect(Object.keys(STAGES).sort()).to.deep.equal([...VOCABULARY].sort());
  });

  it("pins the vocabulary at the size the contract declares", () => {
    expect(VOCABULARY).to.have.lengthOf(STAGE_COUNT);
    expect(new Set(VOCABULARY).size).to.equal(STAGE_COUNT);
  });

  it("binds every stage to a callable handler", () => {
    for (const name of VOCABULARY) {
      expect(STAGES[name], name).to.be.a("function");
    }
  });
});
