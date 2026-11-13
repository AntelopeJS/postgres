import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { ApplyRaw } from "./pipeline-fixture";
import { Render } from "../../implementations/database/render";

const ODD_IDS = [
  { label: "boolean", id: true },
  { label: "null", id: null },
  { label: "object", id: { a: 1 } },
  { label: "array", id: [1] },
];

const FILTER_CONSTANT_TAIL = "WHERE (($1::boolean))";

const FILTER_ARGUMENT_TAIL =
  "WHERE ((jsonb_build_object('stage', to_jsonb(($1::text)), 'args', ($2::jsonb)) <> ALL (array['null', 'false', '0', '\"\"']::jsonb[])))";

const MAP_CONSTANT =
  'SELECT ($1::double precision) AS "value" FROM "directory"."people" AS "t0"';

describe("lambda parameter ids that are neither numbers nor texts", () => {
  for (const { label, id } of ODD_IDS) {
    it(`compiles a filter whose only id is ${label} and whose body is a constant`, () => {
      const filter = QueryStage(
        "filter",
        undefined,
        QueryStage("func", undefined, [id], true),
      );
      const sql = Render(ApplyRaw([filter]).relation);

      expect(sql.endsWith(FILTER_CONSTANT_TAIL)).to.equal(true);
    });

    it(`compiles a filter whose body reads the ${label} id back`, () => {
      const filter = QueryStage(
        "filter",
        undefined,
        QueryStage("func", undefined, [id], QueryStage("arg", undefined, id)),
      );
      const sql = Render(ApplyRaw([filter]).relation);

      expect(sql.endsWith(FILTER_ARGUMENT_TAIL)).to.equal(true);
    });
  }

  it("compiles a map whose id is an empty object", () => {
    const map = QueryStage(
      "map",
      undefined,
      QueryStage("func", undefined, [{}], 5),
    );
    const sql = Render(ApplyRaw([map]).relation);

    expect(sql).to.equal(MAP_CONSTANT);
  });
});
