import type {
  DeepPartial,
  StagedObject,
} from "@antelopejs/interface-database/common";
import { QueryStage } from "@antelopejs/interface-database/common";
import { Query } from "@antelopejs/interface-database/query";
import { expect } from "chai";
import {
  AssertedIdentity,
  CrossInstanceRoot,
  EVERY_ROW,
  ExpectBalancedLedger,
  FROM_TABLE,
  IdentityPredicate,
  LOGS_TABLE,
  LogsRoot,
  NOTES_TABLE,
  type Note,
  NotesRoot,
  Occurrences,
  PeopleDocument,
  type Person,
  ROW_COLUMNS,
  Root,
  SELECTED_ROW,
  WrittenSql as Sql,
  TABLE,
  UnchangedRows,
  Write,
  type WriteDocument,
  type Written,
} from "./pipeline-fixture";

const UPDATE = `UPDATE ${TABLE} AS "w0" SET`;
const INSTANCE_PREDICATE = '"_instance" = ';
const EXISTING_EXTRA = `COALESCE("w0"."_extra", '{}'::jsonb)`;
const EXTRA_ASSIGNMENT = '"_extra" = ';

const KEY = "k";
const NICKNAME = "z";
const AGE = 40;
const MINIMUM_AGE = 18;
const SLICE_OFFSET = 1;
const SLICE_COUNT = 2;
const NTH_ROW = 0;
const RECORDED_ARGUMENT = 1;
const RAISE = 1;
const RESPELLED = 2;
const MEMBER = 1;

/** The derived table a mapper's document is held in, and the identity wrap that follows it. */
const MAPPED_HELD = "t1";
const MAPPED_WRAP = "t2";

/** The same two, for a body that spent an alias of its own before the assignment was built. */
const MERGED_HELD = "t1";
const MERGED_MAPPED = "t2";

const MERGED_MEMBER =
  "jsonb_build_object('x', to_jsonb(($2::double precision)))";

const RETURNS_NOTHING = () => undefined;

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
 * The whole statement an unselected `update(…)` compiles to, given its `SET` list.
 *
 * The wrap's alias is a parameter because it is whatever the alias counter had left: a `SET` list
 * that compiled a derived table of its own spent one before the target was built.
 */
function Changes(assignments: string, alias?: string): string {
  return (
    `${UPDATE} ${assignments} WHERE ${IdentityPredicate(EVERY_ROW, alias)}` +
    ` AND ${UnchangedRows(assignments)}`
  );
}

/**
 * The same, for the one `SET` list that states no column-by-column values.
 *
 * A multi-assignment reads its columns out of one derived table, and testing what it would change
 * means spelling that table a second time in the `WHERE` — so the mapper's expression body answers
 * rows matched where every other path answers rows modified.
 */
function Assigns(assignments: string, alias?: string): string {
  return `${UPDATE} ${assignments} WHERE ${IdentityPredicate(EVERY_ROW, alias)}`;
}

function Member(alias: string, name: string): string {
  return `("${alias}"."doc" -> '${name}')`;
}

/** The overflow document a mapper leaves behind: its own, minus everything with a column. */
function MappedExtra(alias: string): string {
  const document = `"${alias}"."doc"`;
  return (
    `COALESCE((CASE WHEN jsonb_typeof(${document}) = 'object' THEN (${document} -` +
    " array['_id', 'name', 'age', 'isActive', 'joined', 'meta']::text[]) END), '{}'::jsonb)"
  );
}

/**
 * Each declared column read back out of the mapper's document, guarded by the type it expects.
 *
 * Transcribed rather than derived: asking `JsonRowSource` for the expected value would assert only
 * that the projection is deterministic, and it is the guard — a member that does not fit its
 * column reading as NULL rather than losing the statement — that this pins.
 */
function MappedReads(alias: string): string {
  const joined = Member(alias, "joined");
  return [
    `(CASE WHEN jsonb_typeof(${Member(alias, "name")}) = 'string'` +
      ` THEN (${Member(alias, "name")} #>> '{}') END)`,
    `(CASE WHEN jsonb_typeof(${Member(alias, "age")}) = 'number'` +
      ` THEN ((${Member(alias, "age")} #>> '{}')::double precision) END)`,
    `(CASE WHEN jsonb_typeof(${Member(alias, "isActive")}) = 'boolean'` +
      ` THEN ((${Member(alias, "isActive")} #>> '{}')::boolean) END)`,
    `(CASE WHEN jsonb_typeof(${joined}) = 'string' AND` +
      ` pg_input_is_valid((${joined} #>> '{}'), 'timestamptz')` +
      ` THEN ((${joined} #>> '{}')::timestamptz) END)`,
    Member(alias, "meta"),
    MappedExtra(alias),
  ].join(", ");
}

/** The multi-assignment a body whose top-level keys are unknowable compiles to. */
function Mapped(body: string, alias: string): string {
  return (
    '("name", "age", "isActive", "joined", "meta", "_extra") =' +
    ` (SELECT ${MappedReads(alias)} FROM (SELECT ${body} AS "doc") AS "${alias}")`
  );
}

/** The one merge `doc.merge({ x: 1 })` compiles to, held in a derived table of its own. */
function Merged(alias: string): string {
  const value = `${PeopleDocument("w0")} || ${MERGED_MEMBER}`;
  return (
    `(SELECT "${alias}"."merged" FROM (SELECT ${value} AS "merged")` +
    ` AS "${alias}" WHERE jsonb_typeof("${alias}"."merged") = 'object')`
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

function Update(document: WriteDocument): Written {
  return Write(
    Root()
      .get(KEY)
      .update(document as unknown as DeepPartial<Person>),
  );
}

describe("the update statement", () => {
  it("sets one declared column and touches the overflow document not at all", () => {
    const written = Update({ age: AGE });
    expect(Sql(written)).to.equal(Updates('"age" = ($3::double precision)'));
    expect(Sql(written)).to.not.contain(EXTRA_ASSIGNMENT);
  });

  it("names a declared field by its column rather than by its field name", () => {
    const written = Write(
      NotesRoot().update({ summary: "s" } as unknown as DeepPartial<Note>),
    );
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
    const written = Write(Root().update({ age: AGE } as DeepPartial<Person>));
    expect(Sql(written)).to.equal(Changes('"age" = ($2::double precision)'));
  });

  it("refuses a payload that is not a document, naming the stage", () => {
    expect(() => Update("a" as unknown as WriteDocument)).to.throw(
      "The 'update' stage takes a document, received a string",
    );
  });

  it("refuses an array rather than writing its indices as keys", () => {
    expect(() => Update([] as unknown as WriteDocument)).to.throw(
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
    expect(() =>
      Write(Root().update({ _id: KEY, age: AGE } as WriteDocument)),
    ).to.throw(
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
    const written = Write(
      NotesRoot().update({ summary: "s" } as unknown as DeepPartial<Note>),
    );
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

  it("refuses the instance column, naming it", () => {
    expect(() => Update({ _instance: "x" })).to.throw(
      "Payload key '_instance' is a column this adapter owns and no payload may write it",
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
          " 'args', jsonb_build_array(to_jsonb(($4::double precision)))))",
      ),
    );
  });
});

describe("update under CROSS_INSTANCE", () => {
  it("changes the rows of every instance without naming one anywhere", () => {
    const written = Write(
      CrossInstanceRoot().update({ age: AGE } as DeepPartial<Person>),
    );
    const assignment = '"age" = ($1::double precision)';
    expect(Sql(written)).to.equal(
      `${UPDATE} ${assignment} WHERE ` +
        `${IdentityPredicate(`SELECT ${ROW_COLUMNS} ${FROM_TABLE}`)}` +
        ` AND ${UnchangedRows(assignment)}`,
    );
    expect(Sql(written)).to.not.contain(INSTANCE_PREDICATE);
  });
});

describe("the update statement's mapper, whose body is a document", () => {
  it("reads the row being written, as its own column rather than out of a document", () => {
    const written = Write(
      Root().update((doc) => ({ age: doc.key("age").add(RAISE) })),
    );
    expect(Sql(written)).to.equal(
      Changes('"age" = ("w0"."age" + ($2::double precision))'),
    );
    expect(Sql(written)).to.not.contain("jsonb_build_object");
    expect(Sql(written)).to.not.contain('"_extra" ->');
  });

  it("splits the body's keys into columns exactly as a document payload does", () => {
    const written = Write(
      Root().update((doc) => ({ nickname: doc.key("name") })),
    );
    expect(Sql(written)).to.equal(
      Changes(
        `"_extra" = (${EXISTING_EXTRA} ||` +
          ` jsonb_build_object('nickname', to_jsonb("w0"."name")))`,
      ),
    );
  });

  it("refuses a body with nothing to write, naming the stage", () => {
    expect(() => Write(Root().update(() => ({})))).to.throw(
      "The 'update' stage was given a payload with nothing to write",
    );
  });

  it("refuses a reserved key the body names, exactly as a document payload does", () => {
    expect(() =>
      Write(Root().update((doc) => ({ _instance: doc.key("name") }))),
    ).to.throw(
      "Payload key '_instance' is a column this adapter owns and no payload may write it",
    );
  });
});

describe("the update statement's mapper, whose body is an expression", () => {
  it("assigns every column at once from one evaluation of the body", () => {
    const written = Write(Root().update((doc) => doc.key("meta")));
    expect(Sql(written)).to.equal(
      Assigns(Mapped('"w0"."meta"', MAPPED_HELD), MAPPED_WRAP),
    );
  });

  it("spells the body exactly once, however many columns read it back", () => {
    const written = Write(Root().update((doc) => doc.merge({ x: MEMBER })));
    expect(Occurrences(Sql(written), MERGED_MEMBER)).to.equal(1);
    expect(Sql(written)).to.contain(
      `FROM (SELECT ${Merged(MERGED_HELD)} AS "doc") AS "${MERGED_MAPPED}")`,
    );
  });

  it("subtracts every declared name and the key column from the overflow document", () => {
    const written = Write(Root().update((doc) => doc.merge({ x: MEMBER })));
    expect(Sql(written)).to.contain(MappedExtra(MERGED_MAPPED));
  });

  it("names a declared field by its column and reads it by its field name", () => {
    const written = Write(
      NotesRoot().update((doc) => doc.merge({ x: MEMBER })),
    );
    expect(Sql(written)).to.contain(
      `UPDATE ${NOTES_TABLE} AS "w0" SET ("summ", "_extra") = (SELECT (CASE WHEN` +
        ` jsonb_typeof(("${MERGED_MAPPED}"."doc" -> 'summary')) = 'string'`,
    );
  });

  it("assigns a bare column where the table declares no fields of its own", () => {
    const written = Write(LogsRoot().update((doc) => doc.merge({ x: MEMBER })));
    expect(Sql(written)).to.contain(
      `UPDATE ${LOGS_TABLE} AS "w0" SET "_extra" = (SELECT COALESCE(`,
    );
    expect(Sql(written)).to.not.contain('("_extra") =');
  });

  it("refuses a mapper that returned nothing, naming the stage", () => {
    expect(() => Write(Root().update(RETURNS_NOTHING as never))).to.throw(
      "The 'update' stage was given a mapper that returned nothing",
    );
  });
});

describe("the update statement's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    ExpectBalancedLedger([
      Update({ age: AGE }),
      Update({ name: undefined }),
      Update({ nickname: NICKNAME }),
      Update({ nickname: undefined }),
      Update({ age: AGE, nickname: NICKNAME, stale: undefined }),
      Update({ _id: KEY, age: AGE }),
      Write(
        Root()
          .get(KEY)
          .update((doc) => ({ _id: KEY, age: doc.key("age") })),
      ),
      Write(CrossInstanceRoot().update({ age: AGE } as DeepPartial<Person>)),
      Write(
        Root()
          .filter((doc) => doc.key("age").ge(MINIMUM_AGE))
          .slice(SLICE_OFFSET, SLICE_COUNT)
          .update({ name: "a" } as DeepPartial<Person>),
      ),
      Write(Root().update((doc) => ({ age: doc.key("age").add(RAISE) }))),
      Write(Root().update((doc) => doc.key("meta"))),
      Write(Root().update((doc) => doc.merge({ x: MEMBER }))),
      Write(LogsRoot().update((doc) => doc.merge({ x: MEMBER }))),
    ]);
  });
});
