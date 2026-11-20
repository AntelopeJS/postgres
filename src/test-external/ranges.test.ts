import { expect } from "chai";
import { z } from "zod";
import {
  type ColumnProfile,
  Profile,
  type RelationProfile,
} from "@antelopejs/interface-database-catalog";
import {
  AssertNoRareValue,
  type FixtureCount,
  type ResultValue,
} from "@antelopejs/interface-database-catalog/testing";

import { Received } from "./received";

/** The labels of `sales.grade` as the relation's description reads them from `pg_enum`. */
const DECLARED_GRADES = '["bronze","silver","gold","platinum"]';

/** The rows of `sales.grades` that hold each value of its `grade` and `level` columns. */
const GRADE_COUNTS = {
  grade: [
    { value: "bronze", rows: 4 },
    { value: "silver", rows: 5 },
    { value: "gold", rows: 8 },
    { value: "platinum", rows: 1 },
  ],
  level: [
    { value: 7001, rows: 4 },
    { value: 7002, rows: 5 },
    { value: 7008, rows: 5 },
    { value: 7009, rows: 4 },
  ],
} satisfies Record<string, FixtureCount[]>;

async function ProfiledColumn(
  column: string,
  relation = "sales.grades",
): Promise<{
  profile: ColumnProfile | undefined;
  relationProfile: RelationProfile;
  results: string;
  received: ResultValue[];
}> {
  const { answer, results } = await Received(() =>
    Profile({ relation, columns: [column] }),
  );
  return {
    profile: answer.columns.find((profiled) => profiled.name === column),
    relationProfile: answer,
    results: results.join("\n"),
    received: results
      .filter((result) => !result.includes(DECLARED_GRADES))
      .map((result): ResultValue => z.json().parse(JSON.parse(result))),
  };
}

describe("the range of an external column", function () {
  this.timeout(120_000);

  it("ends an enum column at labels seen at least 5 times, so no result set holds a rarer one but the declared labels", async () => {
    const { profile, results, relationProfile, received } =
      await ProfiledColumn("grade");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: "silver", max: "gold" },
    });
    expect(results).to.include(DECLARED_GRADES);
    AssertNoRareValue({
      profile: relationProfile,
      results: received,
      counts: GRADE_COUNTS,
    });
  });

  it("ends a column typed as a domain over an enum like an enum column, and counts its nulls", async () => {
    const { profile } = await ProfiledColumn("grade", "sales.domain_grades");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: "silver", max: "gold" },
    });
    expect(profile?.nulls).to.deep.equal({ status: "ok", value: 1 });
  });

  it("ends an integer column at values seen 5 times, past values seen 4 times", async () => {
    const { profile, results, relationProfile, received } =
      await ProfiledColumn("level");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: 7002, max: 7008 },
    });
    expect(results).to.include("7002");
    AssertNoRareValue({
      profile: relationProfile,
      results: received,
      counts: GRADE_COUNTS,
    });
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
