import { expect } from "chai";
import {
  type ColumnProfile,
  Profile,
} from "@antelopejs/interface-database-catalog";

import { Received } from "./received";

/** The labels of `sales.grade` as the relation's description reads them from `pg_enum`. */
const DECLARED_GRADES = '["bronze","silver","gold","platinum"]';

async function ProfiledColumn(
  column: string,
  relation = "sales.grades",
): Promise<{ profile: ColumnProfile | undefined; results: string }> {
  const { answer, results } = await Received(() =>
    Profile({ relation, columns: [column] }),
  );
  return {
    profile: answer.columns.find((profiled) => profiled.name === column),
    results: results.join("\n"),
  };
}

describe("the range of an external column", function () {
  this.timeout(120_000);

  it("ends an enum column at labels seen at least 5 times, so no result set holds a rarer one but the declared labels", async () => {
    const { profile, results } = await ProfiledColumn("grade");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: "silver", max: "gold" },
    });
    expect(results).to.include(DECLARED_GRADES);
    const measured = results.replaceAll(DECLARED_GRADES, "");
    expect(measured).to.include('"silver"');
    expect(measured).to.not.include("bronze");
    expect(measured).to.not.include("platinum");
  });

  it("ends an integer column at values seen 5 times, past values seen 4 times", async () => {
    const { profile, results } = await ProfiledColumn("level");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: 7002, max: 7008 },
    });
    expect(results).to.include("7002");
    expect(results).to.not.include("7001");
    expect(results).to.not.include("7009");
  });

  it("answers empty for an integer column whose every value is seen once", async () => {
    const { profile } = await ProfiledColumn("id");
    expect(profile?.range).to.deep.equal({ status: "error", code: "empty" });
  });

  it("counts int8 values one float8 cannot tell apart as distinct values, so five seen once each stay unnamed", async () => {
    const { profile, results } = await ProfiledColumn(
      "ref",
      "sales.snowflakes",
    );
    expect(profile?.range).to.deep.equal({ status: "error", code: "empty" });
    expect(profile?.categories).to.deep.equal({
      status: "ok",
      value: { values: [], other: 5 },
    });
    expect(results).to.not.match(/15000000000000000\d\d/);
  });
});
