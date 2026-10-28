import { expect } from "chai";

import {
  CrossInstanceRoot,
  EVERY_ROW,
  expectBalancedLedger,
  IdentityPredicate,
  LOGS_TABLE,
  LogsRoot,
  NOTES_TABLE,
  NotesRoot,
  Occurrences,
  PeopleDocument,
  Root,
  WrittenSql as Sql,
  Write,
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

const MINIMUM_AGE = 18;

const SLICE_OFFSET = 1;

const SLICE_COUNT = 2;

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
    " array['_id', '_instance', 'name', 'age', 'isActive', 'joined', 'meta']::text[]) END), '{}'::jsonb)"
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
      Write(Root().update((doc) => ({ _extra: doc.key("name") }))),
    ).to.throw(
      "Payload key '_extra' is a column this adapter owns and no payload may write it",
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
    expect(() => Write(Root().update(RETURNS_NOTHING))).to.throw(
      "The 'update' stage was given a mapper that returned nothing",
    );
  });
});

describe("the update statement's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    expectBalancedLedger([
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
      Write(CrossInstanceRoot().update({ age: AGE })),
      Write(
        Root()
          .filter((doc) => doc.key("age").ge(MINIMUM_AGE))
          .slice(SLICE_OFFSET, SLICE_COUNT)
          .update({ name: "a" }),
      ),
      Write(Root().update((doc) => ({ age: doc.key("age").add(RAISE) }))),
      Write(Root().update((doc) => doc.key("meta"))),
      Write(Root().update((doc) => doc.merge({ x: MEMBER }))),
      Write(LogsRoot().update((doc) => doc.merge({ x: MEMBER }))),
    ]);
  });
});
