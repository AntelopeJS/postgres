import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";
import type { InsertOptions } from "@antelopejs/interface-database/common";

import { SplitWrite } from "../../implementations/database/writes";
import {
  CrossInstanceRoot,
  expectBalancedLedger,
  NOTES_TABLE,
  NotesRoot,
  Occurrences,
  Root,
  CallerRoot,
  WrittenSql as Sql,
  Stages,
  TABLE,
  Write,
  type WriteDocument,
  type Written,
} from "./pipeline-fixture";

const INTO = `INSERT INTO ${TABLE} AS "w0"`;
const CONFLICT = 'ON CONFLICT ("_instance", "_id") DO UPDATE SET';
const MERGED_EXTRA =
  '"_extra" = (COALESCE("w0"."_extra", \'{}\'::jsonb) || EXCLUDED."_extra")';
const EMPTY_EXTRA = "'{}'::jsonb";
const INSTANCE = "($1::text)";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SLICE_START = 0;
const SLICE_END = 5;
const AGE = 3;

const FIRST_GROUP = 0;
const SECOND_GROUP = 1;

/** One statement of a batch, as the data-modifying CTE that carries it names it. */
function Group(index: number, statement: string): string {
  return `"g${index}" AS (${statement})`;
}

/** One recorded insert, through the contract's own builder. */
function Insert(
  documents: WriteDocument | WriteDocument[],
  options?: InsertOptions,
): Written {
  return Write(CallerRoot().insert(documents, options));
}

/** A pipeline stage the builders record without allocating a lambda id. */
function ReadStages(): QueryStage[] {
  return Stages(Root().slice(SLICE_START, SLICE_END));
}

function InsertStage(): QueryStage {
  return QueryStage("insert", undefined, {});
}

describe("the insert statement", () => {
  it("writes one statement with one column list and a tuple per document", () => {
    const written = Insert([{ name: "a" }, { name: "b" }, { name: "c" }]);
    expect(Sql(written)).to.equal(
      `${INTO} ("_id", "_instance", "name", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA}),` +
        ` (($4::text), ($1::text), ($5::text), ${EMPTY_EXTRA}),` +
        ` (($6::text), ($1::text), ($7::text), ${EMPTY_EXTRA})`,
    );
    expect(Occurrences(Sql(written), "INSERT INTO")).to.equal(1);
  });

  it("binds the instance once and references it from every tuple", () => {
    const written = Insert([{ name: "a" }, { name: "b" }]);
    expect(Occurrences(Sql(written), INSTANCE)).to.equal(2);
    expect(written.context.params.all()[0]).to.equal("");
  });

  it("takes a single document as a batch of one", () => {
    expect(Sql(Insert({ name: "a" }))).to.equal(
      `${INTO} ("_id", "_instance", "name", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA})`,
    );
  });

  it("names the declared columns in the order the table declares them", () => {
    const written = Insert({ age: 3, name: "a" });
    expect(Sql(written)).to.contain(
      '("_id", "_instance", "name", "age", "_extra")',
    );
  });

  it("writes NULL where one document of a batch is silent", () => {
    const written = Insert([{ name: "a" }, { age: 3 }]);
    expect(Sql(written)).to.contain(
      `("_id", "_instance", "name", "age", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text), NULL, ${EMPTY_EXTRA}),` +
        ` (($4::text), ($1::text), NULL, ($5::double precision), ${EMPTY_EXTRA})`,
    );
  });

  it("omits a declared column no document supplies", () => {
    const written = Insert({ name: "a" });
    expect(Sql(written)).to.not.contain('"isActive"');
    expect(Sql(written)).to.not.contain('"joined"');
  });

  it("takes a key the payload set to undefined as no key at all", () => {
    const written = Insert({ name: undefined });
    expect(Sql(written)).to.contain('("_id", "_instance", "_extra")');
  });

  it("names a declared field by its column rather than by its field name", () => {
    const written = Write(NotesRoot().insert({ summary: "s" }));
    expect(Sql(written)).to.equal(
      `INSERT INTO ${NOTES_TABLE} AS "w0" ("_id", "_instance", "summ", "_extra")` +
        ` VALUES (($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA})`,
    );
    expect(Sql(written)).to.not.contain("summary");
  });
});

describe("the insert statement's overflow column", () => {
  it("puts an undeclared key in that row's overflow document and nowhere else", () => {
    const written = Insert({ name: "a", nickname: "z" });
    expect(Sql(written)).to.equal(
      `${INTO} ("_id", "_instance", "name", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text),` +
        ` jsonb_build_object('nickname', to_jsonb(($4::text))))`,
    );
  });

  it("writes an empty object rather than NULL for a row with no undeclared keys", () => {
    expect(Sql(Insert({ name: "a" }))).to.contain(EMPTY_EXTRA);
  });

  it("keeps each row's overflow document to that row", () => {
    const written = Insert([{ nickname: "z" }, { name: "a" }]);
    expect(Occurrences(Sql(written), "jsonb_build_object")).to.equal(1);
    expect(Occurrences(Sql(written), EMPTY_EXTRA)).to.equal(1);
  });
});

describe("the insert statement's conflict modes", () => {
  it("emits no conflict clause when the caller named no mode", () => {
    expect(Sql(Insert({ name: "a" }))).to.not.contain("ON CONFLICT");
  });

  it("updates only the columns the batch supplied, and merges the overflow", () => {
    const written = Insert({ name: "a" }, { conflict: "update" });
    expect(Sql(written)).to.contain(
      `${CONFLICT} "name" = EXCLUDED."name", ${MERGED_EXTRA}`,
    );
    expect(Sql(written)).to.not.contain('"age" = EXCLUDED."age"');
  });

  it("replaces every declared column, and assigns the overflow rather than merging it", () => {
    const written = Insert({ name: "a" }, { conflict: "replace" });
    expect(Sql(written)).to.contain(
      `("_id", "_instance", "name", "age", "isActive", "joined", "meta", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text), NULL, NULL, NULL, NULL, ${EMPTY_EXTRA})`,
    );
    expect(Sql(written)).to.contain(
      `${CONFLICT} "name" = EXCLUDED."name", "age" = EXCLUDED."age",` +
        ` "isActive" = EXCLUDED."isActive", "joined" = EXCLUDED."joined",` +
        ` "meta" = EXCLUDED."meta", "_extra" = EXCLUDED."_extra"`,
    );
    expect(Sql(written)).to.not.contain("COALESCE");
  });

  it("refuses a conflict mode it does not know, naming the ones it does", () => {
    expect(() =>
      Insert({ name: "a" }, { conflict: "ignore" } as unknown as InsertOptions),
    ).to.throw(
      "The 'insert' stage takes a conflict mode of update or replace, received \"ignore\"",
    );
  });
});

describe("the insert statement's heterogeneous batch", () => {
  it("writes one statement per supplied-key signature under a merging conflict", () => {
    const written = Insert(
      [
        { _id: "a", name: "x" },
        { _id: "b", age: AGE },
      ],
      { conflict: "update" },
    );
    const named =
      `${INTO} ("_id", "_instance", "name", "_extra") VALUES` +
      ` (($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA})` +
      ` ${CONFLICT} "name" = EXCLUDED."name", ${MERGED_EXTRA}`;
    const aged =
      `${INTO} ("_id", "_instance", "age", "_extra") VALUES` +
      ` (($4::text), ($1::text), ($5::double precision), ${EMPTY_EXTRA})` +
      ` ${CONFLICT} "age" = EXCLUDED."age", ${MERGED_EXTRA}`;
    expect(Sql(written)).to.equal(
      `WITH ${Group(FIRST_GROUP, named)}, ${Group(SECOND_GROUP, aged)} SELECT 1`,
    );
  });

  it("assigns no column a group's rows were silent about", () => {
    const written = Insert([{ name: "x" }, { age: AGE }], {
      conflict: "update",
    });
    expect(Sql(written)).to.not.contain("NULL");
    expect(Occurrences(Sql(written), 'EXCLUDED."name"')).to.equal(1);
    expect(Occurrences(Sql(written), 'EXCLUDED."age"')).to.equal(1);
  });

  it("groups by the keys a row supplied rather than by where it sits in the batch", () => {
    const written = Insert([{ name: "x" }, { age: AGE }, { name: "y" }], {
      conflict: "update",
    });
    expect(Occurrences(Sql(written), "INSERT INTO")).to.equal(2);
    expect(Sql(written)).to.contain(
      `(($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA}),` +
        ` (($6::text), ($1::text), ($7::text), ${EMPTY_EXTRA})`,
    );
  });

  it("keeps a batch that supplied one key set to a single statement", () => {
    const written = Insert([{ name: "x" }, { name: "y" }], {
      conflict: "update",
    });
    expect(Sql(written)).to.not.contain("WITH");
    expect(Occurrences(Sql(written), "INSERT INTO")).to.equal(1);
  });

  it("leaves a batch with no conflict mode one statement, NULL being what an omitted key means", () => {
    expect(Sql(Insert([{ name: "x" }, { age: AGE }]))).to.not.contain("WITH");
  });

  it("leaves a replacing batch one statement, since it names every column anyway", () => {
    const written = Insert([{ name: "x" }, { age: AGE }], {
      conflict: "replace",
    });
    expect(Sql(written)).to.not.contain("WITH");
    expect(Occurrences(Sql(written), "INSERT INTO")).to.equal(1);
  });

  it("answers the keys in input order rather than in the order the groups write them", () => {
    const written = Insert(
      [
        { _id: "a", name: "x" },
        { _id: "b", age: AGE },
        { _id: "c", name: "y" },
      ],
      { conflict: "update" },
    );
    expect(written.statement.ids).to.deep.equal(["a", "b", "c"]);
  });
});

describe("the ids an insert answers", () => {
  it("generates a key for every document, in input order", () => {
    const written = Insert([{ name: "a" }, { name: "b" }]);
    const ids = written.statement.ids ?? [];
    expect(ids).to.have.lengthOf(2);
    for (const id of ids) {
      expect(id).to.match(UUID_PATTERN);
    }
    expect(new Set(ids).size).to.equal(2);
  });

  it("keeps a key the document supplied", () => {
    const written = Insert([{ _id: "k", name: "a" }, { name: "b" }]);
    expect(written.statement.ids?.[0]).to.equal("k");
    expect(written.statement.ids?.[1]).to.match(UUID_PATTERN);
  });

  it("names the key column once for a document that supplied one", () => {
    const written = Insert({ _id: "k", name: "a" });
    expect(Sql(written)).to.equal(
      `${INTO} ("_id", "_instance", "name", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA})`,
    );
    expect(written.context.params.all()).to.deep.equal(["", "k", "a"]);
  });

  it("reads the supplied key wherever the payload wrote it", () => {
    const written = Insert({ name: "a", _id: "k" });
    expect(Sql(written)).to.contain(
      `VALUES (($3::text), ($1::text), ($2::text), ${EMPTY_EXTRA})`,
    );
    expect(written.context.params.all()).to.deep.equal(["", "a", "k"]);
  });

  it("generates a key for a document that only names one", () => {
    const written = Insert({ _id: undefined, name: "a" });
    expect(written.statement.ids?.[0]).to.match(UUID_PATTERN);
    expect(written.context.params.all()).to.deep.equal([
      "",
      written.statement.ids?.[0],
      "a",
    ]);
  });

  it("generates a key for a document that set its key to null", () => {
    const written = Insert({ _id: null, name: "a" });
    expect(written.statement.ids?.[0]).to.match(UUID_PATTERN);
    expect(Sql(written)).to.equal(
      `${INTO} ("_id", "_instance", "name", "_extra") VALUES` +
        ` (($2::text), ($1::text), ($3::text), ${EMPTY_EXTRA})`,
    );
    expect(written.context.params.all()).to.deep.equal([
      "",
      written.statement.ids?.[0],
      "a",
    ]);
  });

  it("refuses a key that is not a string", () => {
    expect(() => Insert({ _id: 7 })).to.throw(
      "An inserted document's '_id' must be a string, received number",
    );
  });

  it("answers an empty batch without a statement to run", () => {
    const written = Insert([]);
    expect(written.statement.ids).to.deep.equal([]);
    expect(written.statement.sql).to.equal("");
  });

  it("refuses an argument that is not a document", () => {
    expect(() => Insert("a" as unknown as WriteDocument)).to.throw(
      "The 'insert' stage takes documents, and the one at position 0 is a string",
    );
  });

  it("refuses a nested array rather than storing its indices as keys", () => {
    expect(() => Insert([[] as unknown as WriteDocument])).to.throw(
      "The 'insert' stage takes documents, and the one at position 0 is an array",
    );
  });
});

describe("insert under CROSS_INSTANCE", () => {
  it("refuses the write, naming the stage", () => {
    expect(() => Write(CrossInstanceRoot().insert({ name: "a" }))).to.throw(
      "The 'insert' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one",
    );
  });
});

describe("splitting a terminal write off the pipeline", () => {
  it("leaves a read-only query whole", () => {
    const stages = ReadStages();
    const split = SplitWrite(stages);
    expect(split.write).to.equal(undefined);
    expect(split.pipeline).to.deep.equal(stages);
  });

  it("takes the trailing write off the pipeline", () => {
    const write = InsertStage();
    const split = SplitWrite([write]);
    expect(split.write).to.equal(write);
    expect(split.pipeline).to.deep.equal([]);
  });

  it("refuses a write that is not the last stage, naming it", () => {
    expect(() => SplitWrite([InsertStage(), ...ReadStages()])).to.throw(
      "The 'insert' stage writes and can only be the last stage of a query",
    );
  });

  it("refuses a second write behind the last one", () => {
    expect(() => SplitWrite([InsertStage(), InsertStage()])).to.throw(
      "The 'insert' stage writes and can only be the last stage of a query",
    );
  });

  it("refuses an insert that follows a stage it would discard, naming every one", () => {
    expect(() => SplitWrite([...ReadStages(), InsertStage()])).to.throw(
      "The 'insert' stage does not read the rows it is applied to, so every stage before it would be discarded: 'slice'",
    );
  });
});

describe("the insert statement's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    expectBalancedLedger([
      Insert({ name: "a", age: 3 }),
      Insert([{ name: "a" }, { age: 3, nickname: "z" }]),
      Insert({ _id: "k", name: "a" }, { conflict: "update" }),
      Insert({ name: "a", nickname: "z" }, { conflict: "replace" }),
      Insert([{ name: "a" }, { age: 3, nickname: "z" }], {
        conflict: "update",
      }),
    ]);
  });
});
