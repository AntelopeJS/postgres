import { expect } from "chai";
import { Query } from "@antelopejs/interface-database/query";
import { QueryStage } from "@antelopejs/interface-database/common";
import type { StagedObject } from "@antelopejs/interface-database/common";

import {
  AssertedIdentity,
  CrossInstanceRoot,
  FROM_TABLE,
  IdentityPredicate,
  NOTES_TABLE,
  NotesRoot,
  Occurrences,
  ROW_COLUMNS,
  Root,
  SELECTED_ROW,
  WrittenSql as Sql,
  UnchangedRows,
  Write,
  type WriteDocument,
} from "./pipeline-fixture";
import {
  UPDATE,
  EXISTING_EXTRA,
  KEY,
  NICKNAME,
  AGE,
  RAISE,
  Changes,
  Update,
} from "./writes-update-fixture";
import { NotADocument } from "./invalid-fixture";

const INSTANCE_PREDICATE = '"_instance" = ';

const EXTRA_ASSIGNMENT = '"_extra" = ';

const NTH_ROW = 0;

const RECORDED_ARGUMENT = 1;

const RESPELLED = 2;

/**
 * The whole statement a `get(k).update(…)` compiles to, given its `SET` list.
 *
 * The key a payload asserts is a parameter rather than something a spec appends, because the
 * conjunct that keeps unchanged rows out of the count comes after it.
 */
function Updates(assignments: string, asserted?: string): string {
  const narrowed = asserted ? ` AND ${asserted}` : "";
  return (
    `${UPDATE} ${assignments} WHERE ${IdentityPredicate(SELECTED_ROW)}` +
    `${narrowed} AND ${UnchangedRows(assignments)}`
  );
}

/**
 * An `update` over a selection that answers one row without being a `get`.
 *
 * `nth` yields a datum the contract gives no `update` to, so the stage is appended rather than
 * chained: what the write reads is `Relation.single`, and a query the types can spell would only
 * ever reach it through `get`.
 */
function NthUpdate(document: WriteDocument): StagedObject {
  return new Query<number>(
    QueryStage("update", undefined, document),
    Root().nth(NTH_ROW),
  );
}

describe("the update statement", () => {
  it("sets one declared column and touches the overflow document not at all", () => {
    const written = Update({ age: AGE });
    expect(Sql(written)).to.equal(Updates('"age" = ($3::double precision)'));
    expect(Sql(written)).to.not.contain(EXTRA_ASSIGNMENT);
  });

  it("names a declared field by its column rather than by its field name", () => {
    const written = Write(NotesRoot().update({ summary: "s" }));
    expect(Sql(written)).to.contain(
      `UPDATE ${NOTES_TABLE} AS "w0" SET "summ" = ($2::text) WHERE`,
    );
    expect(Sql(written)).to.not.contain("summary");
  });

  it("clears a declared field the payload named as undefined", () => {
    expect(Sql(Update({ name: undefined }))).to.equal(Updates('"name" = NULL'));
  });

  it("sets every column the payload named, in the order it named them", () => {
    const written = Update({ age: AGE, name: "a" });
    expect(Sql(written)).to.equal(
      Updates('"age" = ($3::double precision), "name" = ($4::text)'),
    );
  });

  it("answers a count rather than a list of keys", () => {
    expect(Update({ age: AGE }).statement.ids).to.equal(undefined);
  });

  it("targets every row the pipeline selected, not only a single one", () => {
    const written = Write(Root().update({ age: AGE }));
    expect(Sql(written)).to.equal(Changes('"age" = ($2::double precision)'));
  });

  it("refuses a payload that is not a document, naming the stage", () => {
    expect(() => Update(NotADocument("a"))).to.throw(
      "The 'update' stage takes a document, received a string",
    );
  });

  it("refuses an array rather than writing its indices as keys", () => {
    expect(() => Update(NotADocument([]))).to.throw(
      "The 'update' stage takes a document, received an array",
    );
  });
});

describe("the update statement's overflow column", () => {
  it("writes an undeclared key into the overflow document and no declared column", () => {
    const written = Update({ nickname: NICKNAME });
    expect(Sql(written)).to.equal(
      Updates(
        `"_extra" = (${EXISTING_EXTRA} ||` +
          ` jsonb_build_object('nickname', to_jsonb(($3::text))))`,
      ),
    );
  });

  it("subtracts an undeclared key the payload named as undefined", () => {
    expect(Sql(Update({ nickname: undefined }))).to.equal(
      Updates(`"_extra" = (${EXISTING_EXTRA} - array['nickname']::text[])`),
    );
  });

  it("composes an addition and a removal into one assignment, concatenating first", () => {
    const written = Update({ age: AGE, nickname: NICKNAME, stale: undefined });
    expect(Sql(written)).to.equal(
      Updates(
        '"age" = ($3::double precision),' +
          ` "_extra" = ((${EXISTING_EXTRA} ||` +
          ` jsonb_build_object('nickname', to_jsonb(($4::text))))` +
          " - array['stale']::text[])",
      ),
    );
    expect(Occurrences(Sql(written), EXTRA_ASSIGNMENT)).to.equal(1);
  });
});

describe("the update statement's asserted identity", () => {
  it("narrows the target to the row the payload's key names, assigning nothing", () => {
    const written = Update({ _id: KEY, age: AGE });
    expect(Sql(written)).to.equal(
      Updates('"age" = ($4::double precision)', AssertedIdentity("$3")),
    );
    expect(Sql(written)).to.not.contain('SET "_id"');
  });

  it("asserts the key wherever in the payload it was named", () => {
    const written = Update({ age: AGE, _id: KEY });
    expect(Sql(written)).to.equal(
      Updates('"age" = ($3::double precision)', AssertedIdentity("$4")),
    );
  });

  it("asserts nothing for a key the payload only names", () => {
    expect(Sql(Update({ _id: undefined, age: AGE }))).to.equal(
      Updates('"age" = ($3::double precision)'),
    );
  });

  /**
   * `_id` is `NOT NULL`, so an asserted null matches no row on any dataset — the write would answer
   * 0 for a payload mistake and read as "no such row". A null key is an absent one instead.
   */
  it("asserts nothing for a key the payload set to null", () => {
    expect(Sql(Update({ _id: null, age: AGE }))).to.equal(
      Sql(Update({ age: AGE })),
    );
  });

  /**
   * A key asserted over rows the write did not address one by one is a mistake, not a narrowing:
   * the caller wrote one document over a selection of many and would silently reach at most one.
   */
  it("refuses a key asserted over a selection of many rows, naming what to do", () => {
    const keyed = { _id: KEY, age: AGE };
    expect(() => Write(Root().update(keyed))).to.throw(
      "The 'update' stage was given a payload naming '_id' over a selection of many rows: address the row with get(_id) first, or leave '_id' out of the payload",
    );
  });

  it("refuses the key a mapper's document body names over the same selection", () => {
    expect(() =>
      Write(Root().update((doc) => ({ _id: KEY, age: doc.key("age") }))),
    ).to.throw("over a selection of many rows");
  });

  it("takes the key over any selection that answers one row, not only a get", () => {
    const written = Write(NthUpdate({ _id: KEY, age: AGE }));
    expect(Sql(written)).to.contain(AssertedIdentity("$3"));
  });

  it("asserts the key a mapper's document body names, exactly as a payload does", () => {
    const written = Write(
      Root()
        .get(KEY)
        .update((doc) => ({ _id: KEY, age: doc.key("age").add(RAISE) })),
    );
    expect(Sql(written)).to.equal(
      Updates(
        '"age" = ("w0"."age" + ($4::double precision))',
        AssertedIdentity("$3"),
      ),
    );
  });
});

describe("the count an update answers", () => {
  /**
   * The contract types the answer as the number of modified documents, and the driver reports the
   * number matched — so the statement asks the question itself, in the text and with no new `$n`.
   */
  it("leaves a row the assignment would not change out of the rows it writes", () => {
    expect(Sql(Update({ age: AGE }))).to.contain(
      ' AND (("w0"."age") IS DISTINCT FROM (($3::double precision)))',
    );
  });

  it("tests every column it assigns at once, the overflow document included", () => {
    expect(Sql(Update({ age: AGE, nickname: NICKNAME }))).to.contain(
      ` AND (("w0"."age", "w0"."_extra") IS DISTINCT FROM` +
        ` (($3::double precision), (${EXISTING_EXTRA} ||` +
        " jsonb_build_object('nickname', to_jsonb(($4::text))))))",
    );
  });

  it("spells the values it compares against rather than binding them a second time", () => {
    const written = Update({ age: AGE });
    expect(written.context.params.all()).to.deep.equal(["", KEY, AGE]);
    expect(Occurrences(Sql(written), "$3")).to.equal(RESPELLED);
  });

  /** The two differ wherever `PgIdentifier` truncated the name apart. */
  it("names the column rather than the field it was declared under", () => {
    const written = Write(NotesRoot().update({ summary: "s" }));
    expect(Sql(written)).to.contain(
      ' AND (("w0"."summ") IS DISTINCT FROM (($2::text)))',
    );
    expect(Sql(written)).to.not.contain("summary");
  });

  it("counts a cleared column as changed only where it held something", () => {
    expect(Sql(Update({ name: undefined }))).to.contain(
      ' AND (("w0"."name") IS DISTINCT FROM (NULL))',
    );
  });

  /**
   * The one path left answering rows matched: the body is a derived table in the `SET` list, and
   * testing it would spell that table a second time — measured at 1.6× to 1.8× the whole statement,
   * and a second evaluation of the mapper on every candidate row.
   */
  it("leaves the mapper's expression body counting the rows it matched", () => {
    const written = Write(Root().update((doc) => doc.key("meta")));
    expect(Sql(written)).to.not.contain("IS DISTINCT FROM");
  });
});

describe("the update statement's refusals", () => {
  it("refuses a payload with nothing to write, naming the stage", () => {
    expect(() => Update({})).to.throw(
      "The 'update' stage was given a payload with nothing to write",
    );
  });

  it("drops the instance column, leaving a payload with nothing else to write", () => {
    expect(() => Update({ _instance: "x" })).to.throw(
      "The 'update' stage was given a payload with nothing to write",
    );
  });

  it("refuses the overflow column, naming it", () => {
    expect(() => Update({ _extra: {} })).to.throw(
      "Payload key '_extra' is a column this adapter owns and no payload may write it",
    );
  });

  it("refuses a payload that names the key and nothing else to write", () => {
    expect(() => Update({ _id: KEY })).to.throw(
      "The 'update' stage was given a payload with nothing to write",
    );
  });

  /**
   * A recorded lambda is a plain `{ stage, args }` object, so the two are told apart by shape —
   * and a caller's own document may spell both keys. The refusal reads the parameter-id list as
   * well as the stage name for exactly this payload, which is a document and is written as one.
   */
  it("writes a document whose leading argument is a list of something else", () => {
    const written = Update({ stage: "func", args: [["a"], RECORDED_ARGUMENT] });
    expect(Sql(written)).to.contain(`"_extra" = (${EXISTING_EXTRA} ||`);
    expect(Sql(written)).to.not.contain('AS "doc"');
  });

  it("writes a document whose two keys happen to spell a mapper", () => {
    const written = Update({ stage: "func", args: [RECORDED_ARGUMENT] });
    expect(Sql(written)).to.equal(
      Updates(
        `"_extra" = (${EXISTING_EXTRA} || jsonb_build_object(` +
          `'stage', to_jsonb(($3::text)),` +
          " 'args', ($4::jsonb)))",
      ),
    );
  });
});

describe("update under CROSS_INSTANCE", () => {
  it("changes the rows of every instance without naming one anywhere", () => {
    const written = Write(CrossInstanceRoot().update({ age: AGE }));
    const assignment = '"age" = ($1::double precision)';
    expect(Sql(written)).to.equal(
      `${UPDATE} ${assignment} WHERE ` +
        `${IdentityPredicate(`SELECT ${ROW_COLUMNS} ${FROM_TABLE}`)}` +
        ` AND ${UnchangedRows(assignment)}`,
    );
    expect(Sql(written)).to.not.contain(INSTANCE_PREDICATE);
  });
});
