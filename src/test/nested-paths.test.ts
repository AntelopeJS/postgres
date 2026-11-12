import { expect } from "chai";
import {
  IsDuplicateKeyError,
  type DuplicateKeyError,
  type Stream,
} from "@antelopejs/interface-database";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { AcquireClient, Query } from "../connection";
import { Render } from "../implementations/database/render";
import { QuoteIdentifier } from "../implementations/database/sql";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileExpression } from "../implementations/database/expression";
import { SchemaName } from "../implementations/database/identifier";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import { WaitForIndexes } from "../implementations/database/schema";

interface Localized {
  fr: string;
  en: string;
}

interface Book {
  _id: string;
  title: Localized;
  _internal: { data: { title: Localized } };
  "title.fr"?: string;
  "_internal.data.title.fr"?: string;
}

interface Review {
  _id: string;
  bookTitle: string;
}

interface Event {
  _id: string;
  meta: { at: Date };
  "meta.at"?: Date;
}

interface Tables {
  books: Book;
  booksIndexed: Book;
  reviews: Review;
  events: Event;
}

type BookTable = "books" | "booksIndexed";

const SCHEMA_ID = "nested_paths";
const INSTANCE = "one";

const BOOK_FIELDS = { title: { fr: "string", en: "string" } };

const DEFINITION: SchemaDefinition = {
  books: { fields: BOOK_FIELDS, indexes: {} },
  booksIndexed: {
    fields: BOOK_FIELDS,
    indexes: {
      titleFr: { fields: ["title.fr"], unique: true },
      internalTitleFr: { fields: ["_internal.data.title.fr"], unique: true },
    },
  },
  reviews: { fields: { bookTitle: "string" }, indexes: {} },
  events: {
    fields: { meta: { at: "date" } },
    indexes: { metaAt: { fields: ["meta.at"], unique: true } },
  },
};

const FRENCH = ["delta", "alpha", "echo", "charlie", "bravo"];
const ENGLISH = ["a", "b", "c", "d", "e"];

function MakeBook(fr: string, position: number): Book {
  const title = { fr, en: ENGLISH[position] };
  return { _id: `book-${position}`, title, _internal: { data: { title } } };
}

const BOOKS = FRENCH.map(MakeBook);
const BY_FRENCH = [...BOOKS]
  .sort((left, right) => left.title.fr.localeCompare(right.title.fr))
  .map((book) => book._id);

const REVIEWED = ["charlie", "alpha"];

const EVENT_TIMES = [3000, 1000, 2000];
const EVENTS: Event[] = EVENT_TIMES.map((time, n) => ({
  _id: `event-${n}`,
  meta: { at: new Date(time) },
}));

let schema: Schema<Tables>;

function Table<K extends keyof Tables>(table: K) {
  return schema.instance(INSTANCE).table(table);
}

async function Ids(stream: Stream<Book>): Promise<string[]> {
  return (await stream).map((book) => book._id);
}

async function LookedUp(
  table: BookTable,
  otherKey: "title.fr" | "_internal.data.title.fr",
): Promise<(string | undefined)[]> {
  const reviews = await Table("reviews")
    .orderBy("_id")
    .lookup(Table(table), "bookTitle", otherKey);
  return reviews.map((review) => review.bookTitle?._id);
}

function Compile(stream: Stream<Book>) {
  const context = new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
  const root = BuildRoot(stream.build(), context);
  const relation = ApplyStages(root.relation, root.rest, context);
  return { sql: Render(relation), params: context.params.all() };
}

async function PlanOverIndexes(stream: Stream<Book>): Promise<string> {
  const compiled = Compile(stream);
  const client = await AcquireClient();
  try {
    await client.query("BEGIN");
    for (const method of ["seqscan", "bitmapscan", "sort"]) {
      await client.query(`SET LOCAL enable_${method} = off`);
    }
    const plan = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN ${compiled.sql}`,
      compiled.params,
    );
    return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function InsertRejected(book: Book): Promise<DuplicateKeyError> {
  try {
    await Table("booksIndexed").insert(book);
  } catch (error) {
    if (IsDuplicateKeyError(error)) {
      return error;
    }
    throw error;
  }
  return expect.fail(`the insert of ${book._id} was not refused`);
}

describe("dotted names read nested paths", () => {
  before(async () => {
    await Query(
      `DROP SCHEMA IF EXISTS ${QuoteIdentifier(SchemaName(SCHEMA_ID))} CASCADE`,
    );
    schema = new Schema<Tables>(SCHEMA_ID, DEFINITION);
    await WaitForIndexes(SCHEMA_ID);
    await schema.createInstance(INSTANCE);
    await Table("books").insert(BOOKS);
    await Table("booksIndexed").insert(BOOKS);
    await Table("events").insert(EVENTS);
    await Table("reviews").insert(
      REVIEWED.map((bookTitle, n) => ({ _id: `review-${n}`, bookTitle })),
    );
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE);
  });

  it("orderBy sorts by a path below a declared field", async () => {
    expect(await Ids(Table("books").orderBy("title.fr"))).to.deep.equal(
      BY_FRENCH,
    );
    expect(await Ids(Table("books").orderBy("title.fr", "desc"))).to.deep.equal(
      [...BY_FRENCH].reverse(),
    );
  });

  it("orderBy sorts by a path below an undeclared key", async () => {
    expect(
      await Ids(Table("books").orderBy("_internal.data.title.fr")),
    ).to.deep.equal(BY_FRENCH);
  });

  it("orderBy by an index over a path sorts by that path", async () => {
    expect(await Ids(Table("booksIndexed").orderBy("titleFr"))).to.deep.equal(
      BY_FRENCH,
    );
    expect(
      await Ids(Table("booksIndexed").orderBy("internalTitleFr")),
    ).to.deep.equal(BY_FRENCH);
  });

  it("getAll by an index over a path and between by a path match that path", async () => {
    expect(
      await Ids(Table("booksIndexed").getAll("charlie", "titleFr")),
    ).to.deep.equal(["book-3"]);
    expect(
      await Ids(
        Table("books")
          .between("_internal.data.title.fr", "bravo", "delta")
          .orderBy("_id"),
      ),
    ).to.deep.equal(["book-3", "book-4"]);
  });

  for (const table of ["books", "booksIndexed"] as const) {
    it(`lookup finds the ${table} row by a path below a declared field`, async () => {
      expect(await LookedUp(table, "title.fr")).to.deep.equal([
        "book-3",
        "book-1",
      ]);
    });

    it(`lookup finds the ${table} row by a path below an undeclared key`, async () => {
      expect(await LookedUp(table, "_internal.data.title.fr")).to.deep.equal([
        "book-3",
        "book-1",
      ]);
    });
  }

  it("a unique index over a path refuses a second row with the same nested value", async () => {
    const declared = await InsertRejected({
      ...MakeBook("alpha", 9),
      _internal: { data: { title: { fr: "other", en: "x" } } },
    });
    expect(declared.index).to.equal("titleFr");
    const undeclared = await InsertRejected({
      ...MakeBook("other", 9),
      _internal: { data: { title: { fr: "alpha", en: "x" } } },
    });
    expect(undeclared.index).to.equal("internalTitleFr");
  });

  it("an index over a date below a declared field builds, refuses a duplicate, and the sort reads dates", async () => {
    const sorted = await Table("events").orderBy("meta.at");
    expect(sorted.map((event) => event._id)).to.deep.equal([
      "event-1",
      "event-2",
      "event-0",
    ]);
    let refused: unknown;
    try {
      await Table("events").insert({ ...EVENTS[0], _id: "event-copy" });
    } catch (error) {
      refused = error;
    }
    expect(IsDuplicateKeyError(refused) && refused.index).to.equal("metaAt");
  });

  it("the index over a path serves a sort and a match by that path", async () => {
    const sorted = await PlanOverIndexes(
      Table("booksIndexed").orderBy("titleFr"),
    );
    expect(sorted).to.match(/Index Scan using "?booksIndexed_titleFr"?/i);
    const matched = await PlanOverIndexes(
      Table("booksIndexed").getAll("charlie", "internalTitleFr"),
    );
    expect(matched).to.match(
      /Index (Only )?Scan using "?booksIndexed_internalTitleFr"?/i,
    );
  });
});
