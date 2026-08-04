import type { DeepPartial } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import {
  CrossInstanceRoot,
  EVERY_ROW,
  ExpectBalancedLedger,
  IdentityPredicate,
  NOTES_TABLE,
  type Note,
  NotesRoot,
  type Person,
  Root,
  SELECTED_ROW,
  WrittenSql as Sql,
  TABLE,
  Write,
  type WriteDocument,
  type Written,
} from "./pipeline-fixture";

const UPDATE = `UPDATE ${TABLE} AS "w0" SET`;
const EXISTING_EXTRA = `COALESCE("w0"."_extra", '{}'::jsonb)`;
const EMPTY_EXTRA = `"_extra" = '{}'::jsonb`;

/** Every declared column of the people table, stated the way a silent payload states it. */
const SILENT_COLUMNS =
  '"name" = NULL, "age" = NULL, "isActive" = NULL, "joined" = NULL, "meta" = NULL';

const KEY = "k";
const NAME = "a";
const NICKNAME = "z";

function Replaces(assignments: string, rendered = SELECTED_ROW): string {
  return `${UPDATE} ${assignments} WHERE ${IdentityPredicate(rendered)}`;
}

function Replace(document: WriteDocument): Written {
  return Write(
    Root()
      .get(KEY)
      .replace(document as unknown as DeepPartial<Person>),
  );
}

describe("the replace statement", () => {
  it("names every declared column, and nulls the ones the payload was silent about", () => {
    expect(Sql(Replace({ name: NAME }))).to.equal(
      Replaces(
        '"name" = ($3::text), "age" = NULL, "isActive" = NULL,' +
          ` "joined" = NULL, "meta" = NULL, ${EMPTY_EXTRA}`,
      ),
    );
  });

  it("assigns the overflow document rather than merging into the row's own", () => {
    const written = Replace({ nickname: NICKNAME });
    expect(Sql(written)).to.equal(
      Replaces(
        `${SILENT_COLUMNS}, "_extra" =` +
          " jsonb_build_object('nickname', to_jsonb(($3::text)))",
      ),
    );
    expect(Sql(written)).to.not.contain(EXISTING_EXTRA);
  });

  it("empties the row for a payload with nothing in it rather than refusing one", () => {
    expect(Sql(Replace({}))).to.equal(
      Replaces(`${SILENT_COLUMNS}, ${EMPTY_EXTRA}`),
    );
  });

  it("states a field named as undefined exactly as it states one never mentioned", () => {
    expect(Sql(Replace({ name: undefined }))).to.equal(Sql(Replace({})));
  });

  it("drops an undeclared key named as undefined, having nothing to subtract from", () => {
    expect(Sql(Replace({ nickname: undefined }))).to.equal(Sql(Replace({})));
  });

  it("names a declared field by its column rather than by its field name", () => {
    const written = Write(
      NotesRoot().replace({ summary: "s" } as unknown as DeepPartial<Note>),
    );
    expect(Sql(written)).to.contain(
      `UPDATE ${NOTES_TABLE} AS "w0" SET "summ" = ($2::text), ${EMPTY_EXTRA} WHERE`,
    );
    expect(Sql(written)).to.not.contain("summary");
  });

  it("replaces every row the pipeline selected rather than only the first", () => {
    const written = Write(
      Root().replace({ name: NAME } as DeepPartial<Person>),
    );
    expect(Sql(written)).to.equal(
      Replaces(
        `"name" = ($2::text), "age" = NULL, "isActive" = NULL,` +
          ` "joined" = NULL, "meta" = NULL, ${EMPTY_EXTRA}`,
        EVERY_ROW,
      ),
    );
  });

  it("answers a count rather than a list of keys", () => {
    expect(Replace({ name: NAME }).statement.ids).to.equal(undefined);
  });
});

describe("the replace statement's refusals", () => {
  it("refuses to write across every instance at once, naming the stage", () => {
    expect(() =>
      Write(CrossInstanceRoot().replace({ name: NAME } as DeepPartial<Person>)),
    ).to.throw(
      "The 'replace' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one",
    );
  });

  it("refuses the key column, and says to remove it from the payload", () => {
    expect(() => Replace({ _id: KEY })).to.throw(
      "Payload key '_id' identifies the row a write targets: a write cannot change a row's identity, so remove the key from the payload",
    );
  });

  it("refuses the overflow column, naming it", () => {
    expect(() => Replace({ _extra: {} })).to.throw(
      "Payload key '_extra' is a column this adapter owns and no payload may write it",
    );
  });

  it("refuses a payload that is not a document, naming the stage", () => {
    expect(() => Replace(NAME as unknown as WriteDocument)).to.throw(
      "The 'replace' stage takes a document, received a string",
    );
  });
});

describe("the replace statement's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    ExpectBalancedLedger([
      Replace({ name: NAME }),
      Replace({}),
      Replace({ nickname: NICKNAME }),
      Replace({ name: NAME, nickname: NICKNAME }),
      Write(Root().replace({ name: NAME } as DeepPartial<Person>)),
    ]);
  });
});
