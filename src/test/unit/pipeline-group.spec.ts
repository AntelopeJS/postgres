import { expect } from "chai";
import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";

import type { Compiled } from "../../implementations/database/sql";

import { BOOL } from "../../implementations/database/types";

import { Render } from "../../implementations/database/render";
import {
  type Applied,
  ApplyRaw,
  ApplySubqueries,
  ReadParamLedger,
  Root,
  Write,
} from "./pipeline-fixture";
import { AGE_COLUMN, NAME_COLUMN } from "./pipeline-group-fixture";

const ACTIVE_COLUMN = '"t0"."isActive"';

const SKILLS_KEY = `("t0"."_extra" -> 'skills')`;

const COMPOUND_INDEX = "byNameAge";

const CONTAINER_INDEX = "byNameSkills";

const SINGLE_TERM = 1;

const ONLY_TERM = 0;

const WRAPPED_ALIAS = "t1";

const DELETE_STAGE = "delete";

const NO_ORIGIN = "A row-mode relation must carry the origin of its table";

/**
 * A group whose mapper answers the group value alone, which is what puts the term in the select
 * list where a spec can read it back.
 */
function GroupedBy(index: string): Applied {
  return ApplySubqueries(Root().group(index, (_stream, group) => group));
}

/** The one term of a group that resolved to a single column. */
function OneTerm(applied: Applied): Compiled {
  expect(applied.relation.groupBy).to.have.lengthOf(SINGLE_TERM);
  return applied.relation.groupBy[ONLY_TERM];
}

function TermTexts(applied: Applied): string[] {
  return applied.relation.groupBy.map((term) => term.sql);
}

function SelectedValue(applied: Applied): string {
  const projection = applied.relation.projection;
  assert(projection, "a group projects the value its mapper answered");
  return projection.sql;
}

/**
 * A `delete` behind a group, recorded the way the contract records one.
 *
 * A group yields a stream the contract gives no `delete` to, so the stage is appended rather than
 * chained — the refusal under test is the compiler's rather than the type system's.
 */
function Deleting(): StagedObject {
  return new Query<number>(
    QueryStage(DELETE_STAGE),
    Root().group("age", (_stream, group) => group),
  );
}

describe("the group stage", () => {
  it("groups by the one column a plain field name resolves to", () => {
    expect(TermTexts(GroupedBy("age"))).to.deep.equal([AGE_COLUMN]);
  });

  it("names that column bare, so a btree index can still serve the grouping", () => {
    const rendered = Render(GroupedBy("age").relation);
    expect(rendered).to.contain(`GROUP BY ${AGE_COLUMN}`);
    expect(rendered).to.not.contain("jsonb_build_object");
  });

  it("resolves _id through the row source, which the field list does not carry", () => {
    expect(TermTexts(GroupedBy("_id"))).to.deep.equal(['"t0"."_id"']);
  });

  it("spells the group value in the select list as the term itself", () => {
    const grouped = GroupedBy("age");
    expect(SelectedValue(grouped)).to.equal(OneTerm(grouped).sql);
  });

  it("spells the same term inside a mapper's document of members", () => {
    const grouped = ApplySubqueries(
      Root().group("age", (stream, group) => ({
        key: group,
        rows: stream.count(),
      })),
    );
    expect(SelectedValue(grouped)).to.contain(OneTerm(grouped).sql);
  });

  it("yields many rows rather than one, and blocks what reads an aggregate", () => {
    const { relation } = GroupedBy("age");
    expect(relation.aggregated).to.equal(true);
    expect(relation.single).to.equal(false);
  });

  it("names itself when the stage carries no index to group on", () => {
    expect(() => ApplyRaw([QueryStage("group", {})])).to.throw(
      "The 'group' stage is missing the index or field to group on",
    );
  });

  it("binds no parameter for a mapper that reads the group alone", () => {
    expect(GroupedBy("age").context.params.all()).to.deep.equal([]);
  });
});

describe("a group on a compound index", () => {
  it("groups by every column the index declares, in its own order", () => {
    expect(TermTexts(GroupedBy(COMPOUND_INDEX))).to.deep.equal([
      NAME_COLUMN,
      AGE_COLUMN,
    ]);
  });

  it("hands the mapper a document keyed by the index's own fields", () => {
    expect(SelectedValue(GroupedBy(COMPOUND_INDEX))).to.equal(
      `(jsonb_strip_nulls(jsonb_build_object('name', ${NAME_COLUMN},` +
        ` 'age', ${AGE_COLUMN})))`,
    );
  });

  it("names in that document exactly the columns it grouped by", () => {
    const grouped = GroupedBy(COMPOUND_INDEX);
    for (const term of TermTexts(grouped)) {
      expect(SelectedValue(grouped)).to.contain(term);
    }
  });

  it("builds it through the shared builder, so a container member keeps its nulls", () => {
    const grouped = GroupedBy(CONTAINER_INDEX);
    expect(TermTexts(grouped)).to.deep.equal([NAME_COLUMN, SKILLS_KEY]);
    expect(SelectedValue(grouped)).to.contain(
      `(CASE WHEN ${SKILLS_KEY} IS NULL THEN '{}'::jsonb`,
    );
  });

  it("types the group value as the document it built", () => {
    expect(GroupedBy(COMPOUND_INDEX).relation.projection?.type.kind).to.equal(
      "json",
    );
  });
});

describe("the type a group value keeps", () => {
  it("leaves a boolean field a boolean rather than a rendering of one", () => {
    expect(GroupedBy("isActive").relation.projection?.type).to.deep.equal(BOOL);
  });

  it("reads it into a mapper's document as a jsonb boolean", () => {
    const grouped = ApplySubqueries(
      Root().group("isActive", (stream, group) => ({
        paid: group,
        total: stream.sum("age"),
      })),
    );
    expect(SelectedValue(grouped)).to.contain(`to_jsonb(${ACTIVE_COLUMN})`);
    expect(SelectedValue(grouped)).to.not.contain("::text");
  });
});

describe("what a group wraps", () => {
  it("wraps an existing ordering inside, since 42803 refuses it beside a GROUP BY", () => {
    const { relation } = ApplySubqueries(
      Root()
        .orderBy("name", "asc")
        .group("age", (_stream, group) => group),
    );
    expect(relation.alias).to.equal(WRAPPED_ALIAS);
    expect(relation.from).to.contain(`ORDER BY ${NAME_COLUMN} ASC`);
    expect(relation.orderBy).to.deep.equal([]);
    expect(Render(relation)).to.contain(`GROUP BY "${WRAPPED_ALIAS}"."age"`);
  });

  it("is wrapped by an ordering that follows it, which orders the groups", () => {
    const { relation } = ApplySubqueries(
      Root()
        .group("age", (_stream, group) => group)
        .orderBy("name", "asc"),
    );
    expect(relation.alias).to.equal(WRAPPED_ALIAS);
    expect(relation.from).to.contain(`GROUP BY ${AGE_COLUMN}`);
    expect(relation.groupBy).to.deep.equal([]);
  });

  it("is wrapped by a count that follows it, which counts the groups", () => {
    const { relation } = ApplySubqueries(
      Root()
        .group("age", (_stream, group) => group)
        .count(),
    );
    expect(relation.from).to.contain(`GROUP BY ${AGE_COLUMN}`);
    expect(Render(relation)).to.contain("count(*)");
  });

  it("refuses a write after it, the relation no longer knowing a table", () => {
    expect(() => Write(Deleting())).to.throw(NO_ORIGIN);
  });
});

describe("a group whose mapper binds several sub-streams", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    const grouped = ApplySubqueries(
      Root().group("age", (stream, group) => ({
        key: group,
        total: stream.map((row) => row.key("age").default(0)).sum(),
        names: stream.distinct("name"),
        oldest: stream.map((row) => row.key("age").default(1)).max(),
      })),
    );
    const ledger = ReadParamLedger(grouped);
    expect(ledger.bound).to.not.deep.equal([]);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });
});
