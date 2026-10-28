import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";

import type { TableModel } from "../../implementations/database/fields";
import { DecodingContext } from "../../implementations/database/context";
import { CompileExpression } from "../../implementations/database/expression";
import {
  type ParamLedger,
  ParamLedgerOf,
  RefusingCompilers,
} from "./spec-fixture";
import {
  BOOL,
  FLOAT,
  JsonOf,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  ID_AS_ASSERTION,
  ID_AS_KEY,
  type PayloadOptions,
  type PayloadSplit,
  SplitPayload,
} from "../../implementations/database/payload";

const vehicles: TableModel = {
  fields: {
    car: { column: "car", type: TEXT },
    price: { column: "price", type: FLOAT },
    manufactured: { column: "manufactured", type: TIMESTAMP },
    isElectric: { column: "isElectric", type: BOOL },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
    aVeryLongFieldName: { column: "truncated", type: TEXT },
  },
};

const INSERTED: PayloadOptions = { id: ID_AS_KEY };
const TARGETED: PayloadOptions = { id: ID_AS_ASSERTION };

const NUMERIC_TEXT_PATTERN = `'^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$'`;

/** The guarded reading a text value gets against a `number` column, which a cast would refuse. */
function AsNumber(param: string): string {
  return (
    `(CASE WHEN (${param}::text) ~ ${NUMERIC_TEXT_PATTERN}` +
    ` THEN (((${param}::text))::double precision) END)`
  );
}

function NewContext(): DecodingContext {
  return new DecodingContext({
    ...RefusingCompilers(),
    expression: CompileExpression,
  });
}

interface SplitResult {
  split: PayloadSplit;
  context: DecodingContext;
}

function Split(
  document: Parameters<typeof SplitPayload>[0],
  options: PayloadOptions = TARGETED,
): SplitResult {
  const context = NewContext();
  return {
    split: SplitPayload(document, vehicles, context, options),
    context,
  };
}

function Columns(applied: SplitResult): string[] {
  return applied.split.members.map((member) => member.column);
}

function Fragments(applied: SplitResult): string[] {
  return applied.split.members.map((member) => member.value.sql);
}

/** The bind ledger of everything a split carries — a member, the overflow document, the identity. */
function ReadParamLedger(applied: SplitResult): ParamLedger {
  const text = [
    ...Fragments(applied),
    applied.split.extra?.sql ?? "",
    applied.split.identity?.sql ?? "",
  ].join(" ");
  return ParamLedgerOf(text, applied.context.params.all().length);
}

describe("SplitPayload over declared fields", () => {
  it("binds a number as a bare parameter, with no coercion wrapper", () => {
    const applied = Split({ price: 3000 });
    expect(Columns(applied)).to.deep.equal(["price"]);
    expect(Fragments(applied)).to.deep.equal(["($1::double precision)"]);
    expect(applied.context.params.all()).to.deep.equal([3000]);
  });

  it("reads a text value as the column's type rather than casting it", () => {
    const applied = Split({ price: "3000" });
    expect(Fragments(applied)).to.deep.equal([AsNumber("$1")]);
    expect(Fragments(applied)[0]).to.not.equal(
      "(($1::text)::double precision)",
    );
  });

  it("reads an expression's result as the column's type, not as the type it produced", () => {
    const concatenated = "(($1::text) || ($2::text))";
    const applied = Split({ price: ValueProxy.constant("30").concat("00") });
    expect(Columns(applied)).to.deep.equal(["price"]);
    expect(Fragments(applied)).to.deep.equal([
      `(CASE WHEN ${concatenated} ~ ${NUMERIC_TEXT_PATTERN}` +
        ` THEN ((${concatenated})::double precision) END)`,
    ]);
    expect(applied.context.params.all()).to.deep.equal(["30", "00"]);
  });

  it("writes a null as a stored value rather than as a removal", () => {
    const applied = Split({ car: null, price: undefined });
    expect(Columns(applied)).to.deep.equal(["car"]);
    expect(Fragments(applied)).to.deep.equal([
      "(CASE WHEN jsonb_typeof('null'::jsonb) = 'string'" +
        " THEN ('null'::jsonb #>> '{}') END)",
    ]);
    expect(applied.split.cleared).to.deep.equal(["price"]);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  it("binds a date as a timestamptz rather than as a json string", () => {
    const manufactured = new Date("2023-01-15T00:00:00.000Z");
    const applied = Split({ manufactured });
    expect(Fragments(applied)).to.deep.equal(["($1::timestamptz)"]);
    expect(applied.context.params.all()).to.deep.equal([manufactured]);
  });

  it("writes a boolean without a guard or a second cast", () => {
    expect(Fragments(Split({ isElectric: true }))).to.deep.equal([
      "($1::boolean)",
    ]);
  });

  it("refuses a text value for a boolean column, naming the field and both types", () => {
    expect(() => Split({ isElectric: "false" })).to.throw(
      /'isElectric'.*boolean.*received text/,
    );
  });

  it("refuses every other scalar reading rather than rewriting it as truthiness", () => {
    for (const value of [1, 0, new Date(0), ValueProxy.constant("no")]) {
      expect(() => Split({ isElectric: value })).to.throw(/'isElectric'/);
    }
  });

  it("reads a json value against a boolean column under the typeof guard", () => {
    expect(Fragments(Split({ isElectric: null }))).to.deep.equal([
      "(CASE WHEN jsonb_typeof('null'::jsonb) = 'boolean'" +
        " THEN (('null'::jsonb #>> '{}')::boolean) END)",
    ]);
  });

  it("keeps a nested object as one jsonb document, nulls and all", () => {
    const applied = Split({ metadata: { level: 3, note: null } });
    expect(Fragments(applied)).to.deep.equal([
      "jsonb_build_object('level', to_jsonb(($1::double precision))," +
        " 'note', 'null'::jsonb)",
    ]);
    expect(applied.context.params.all()).to.deep.equal([3]);
  });

  /**
   * The three scalar columns clear themselves through the projection guard, which is SQL NULL for a
   * json null. A jsonb column is the one the cast leaves alone, and storing the literal there is
   * what made one value answer three ways — dropped by `DecodeRow`, returned by `pluck`, and
   * reported present by `hasfields`.
   */
  it("clears a declared jsonb column rather than storing a json null in it", () => {
    const applied = Split({ metadata: null });
    expect(Columns(applied)).to.deep.equal(["metadata"]);
    expect(Fragments(applied)).to.deep.equal(["NULL"]);
    expect(applied.split.cleared).to.deep.equal([]);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  it("names the column rather than the field", () => {
    expect(Columns(Split({ aVeryLongFieldName: "x" }))).to.deep.equal([
      "truncated",
    ]);
  });

  it("clears a declared field the payload set to undefined", () => {
    const applied = Split({ car: undefined });
    expect(applied.split.cleared).to.deep.equal(["car"]);
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  it("clears by column name, not by field name", () => {
    expect(
      Split({ aVeryLongFieldName: undefined }).split.cleared,
    ).to.deep.equal(["truncated"]);
  });

  it("walks the payload's keys once, in insertion order", () => {
    const applied = Split({ price: 1, car: "a", isElectric: undefined });
    expect(Columns(applied)).to.deep.equal(["price", "car"]);
    expect(applied.split.cleared).to.deep.equal(["isElectric"]);
    expect(applied.split.removed).to.deep.equal([]);
    expect(applied.split.extra).to.equal(undefined);
  });
});

describe("SplitPayload over undeclared keys", () => {
  it("collects a supplied key into one jsonb object", () => {
    const applied = Split({ productIds: ["a"] });
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.split.extra?.sql).to.equal(
      "jsonb_build_object('productIds', ($1::jsonb))",
    );
  });

  it("subtracts a key the payload set to undefined", () => {
    const applied = Split({ productIds: undefined });
    expect(applied.split.removed).to.deep.equal(["productIds"]);
    expect(applied.split.extra).to.equal(undefined);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  it("carries an addition and a removal side by side", () => {
    const applied = Split({ tags: ["x"], productIds: undefined });
    expect(applied.split.removed).to.deep.equal(["productIds"]);
    expect(applied.split.extra?.sql).to.contain("'tags'");
  });

  it("compiles no overflow object when there is nothing to add", () => {
    const applied = Split({ price: 1, productIds: undefined });
    expect(applied.split.extra).to.equal(undefined);
    expect(applied.context.params.all()).to.deep.equal([1]);
  });

  it("splits declared and undeclared keys of one payload", () => {
    const applied = Split({ productIds: ["a"], price: 1 });
    expect(Columns(applied)).to.deep.equal(["price"]);
    expect(applied.split.extra?.sql).to.contain("'productIds'");
    expect(applied.context.params.all()).to.deep.equal([1, '["a"]']);
  });

  it("does not resolve a key inherited from Object.prototype", () => {
    const applied = Split({ constructor: 1 });
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.split.extra?.sql).to.equal(
      "jsonb_build_object('constructor', to_jsonb(($1::double precision)))",
    );
  });

  it("subtracts an inherited key rather than clearing a column", () => {
    const applied = Split({ constructor: undefined });
    expect(applied.split.removed).to.deep.equal(["constructor"]);
    expect(applied.split.cleared).to.deep.equal([]);
  });

  it("keeps an own __proto__ key as a member rather than as a prototype", () => {
    const applied = Split(JSON.parse('{"__proto__": 1}'));
    expect(applied.split.extra?.sql).to.equal(
      "jsonb_build_object('__proto__', to_jsonb(($1::double precision)))",
    );
  });
});

describe("SplitPayload over the reserved columns", () => {
  it("drops the instance column, which restates where the row already is", () => {
    const applied = Split({ _instance: "x", price: 1 });
    expect(Columns(applied)).to.deep.equal(["price"]);
    expect(applied.split.identity).to.equal(undefined);
    expect(applied.context.params.all()).to.deep.equal([1]);
  });

  it("refuses the overflow column by name", () => {
    expect(() => Split({ _extra: {} })).to.throw(
      "Payload key '_extra' is a column this adapter owns and no payload may write it",
    );
  });

  it("takes the key column as an assertion where the stage targets rows by identity", () => {
    const applied = Split({ _id: "k", price: 1 });
    expect(Columns(applied)).to.deep.equal(["price"]);
    expect(applied.split.identity?.sql).to.equal("($1::text)");
    expect(applied.context.params.all()).to.deep.equal(["k", 1]);
  });

  it("reads the asserted key as text, the way a key is read everywhere else", () => {
    expect(Split({ _id: 1 }).split.identity?.sql).to.equal(
      "((($1::double precision))::text)",
    );
  });

  it("asserts nothing for a key column the payload only names", () => {
    const applied = Split({ _id: undefined });
    expect(applied.split.identity).to.equal(undefined);
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  it("asserts nothing for a key column the payload set to null", () => {
    const applied = Split({ _id: null, price: 1 });
    expect(applied.split.identity).to.equal(undefined);
    expect(Columns(applied)).to.deep.equal(["price"]);
    expect(applied.context.params.all()).to.deep.equal([1]);
  });

  it("refuses the overflow column the payload only names", () => {
    expect(() => Split({ _extra: undefined })).to.throw("Payload key '_extra'");
  });

  it("drops the instance column the payload only names", () => {
    const applied = Split({ _instance: undefined });
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.split.removed).to.deep.equal([]);
  });

  it("takes the key column as a member when the stage is keyed by it", () => {
    const applied = Split({ _id: "k", price: 1 }, INSERTED);
    expect(Columns(applied)).to.deep.equal(["_id", "price"]);
    expect(Fragments(applied)[0]).to.equal("($1::text)");
    expect(applied.context.params.all()).to.deep.equal(["k", 1]);
  });

  it("still refuses the overflow column when the stage is keyed", () => {
    expect(() => Split({ _extra: {} }, INSERTED)).to.throw(
      "Payload key '_extra'",
    );
  });

  it("drops the instance column under the keyed stage too", () => {
    const applied = Split({ _instance: "x" }, INSERTED);
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  it("takes no key from a payload that only names it", () => {
    const applied = Split({ _id: undefined }, INSERTED);
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.split.cleared).to.deep.equal([]);
    expect(applied.split.removed).to.deep.equal([]);
  });

  it("takes no key from a payload that set it to null", () => {
    const applied = Split({ _id: null }, INSERTED);
    expect(applied.split.members).to.deep.equal([]);
    expect(applied.split.cleared).to.deep.equal([]);
    expect(applied.split.removed).to.deep.equal([]);
    expect(applied.context.params.all()).to.deep.equal([]);
  });

  /**
   * The one distinction a null `_id` must not spread to: an undeclared key is a stored value and a
   * json null is one of the values it can store, which is what tells it apart from a removal.
   */
  it("keeps a null under an undeclared key while dropping one under the key column", () => {
    const applied = Split({ _id: null, tags: null }, INSERTED);
    expect(applied.split.extra?.sql).to.equal(
      "jsonb_build_object('tags', 'null'::jsonb)",
    );
    expect(applied.split.removed).to.deep.equal([]);
  });
});

describe("SplitPayload's parameter ledger", () => {
  it("references every parameter it binds, and binds every one it references", () => {
    const splits = [
      Split({ price: 3000, car: "a", metadata: { level: 1 } }),
      Split({ price: undefined, productIds: undefined }),
      Split({ productIds: ["a", "b"], price: "3000" }),
      Split({ _id: "k", tags: ["x"] }, INSERTED),
      Split({ _id: "k", price: 1, tags: ["x"] }),
    ];
    for (const applied of splits) {
      const ledger = ReadParamLedger(applied);
      expect(ledger.referenced).to.deep.equal(ledger.bound);
    }
  });
});
