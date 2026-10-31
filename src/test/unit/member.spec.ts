import { AssertionError } from "node:assert";

import { expect } from "chai";
import { Query, ValueProxy } from "@antelopejs/interface-database";
import {
  QueryStage,
  StagedObject,
} from "@antelopejs/interface-database/common";

import { DecodingContext } from "../../implementations/database/context";
import type { ColumnDescriptor } from "../../implementations/database/external-types";
import {
  type ExternalWriteMode,
  SplitExternalPayload,
} from "../../implementations/database/external-payload";
import type { TableModel } from "../../implementations/database/fields";
import { ClassifyMember } from "../../implementations/database/member";
import { FLOAT, TEXT } from "../../implementations/database/types";
import { DecodeValue } from "../../implementations/database/value";
import { RefusingCompilers } from "./spec-fixture";

const NAMED_KINDS = [
  { label: "undefined", value: undefined, kind: "absent", type: "undefined" },
  { label: "null", value: null, kind: "null", type: "object" },
  { label: "a string", value: "x", kind: "text", type: "string" },
  { label: "a number", value: 1, kind: "number", type: "number" },
  { label: "NaN", value: NaN, kind: "number", type: "number" },
  { label: "a boolean", value: false, kind: "boolean", type: "boolean" },
  { label: "a date", value: new Date(0), kind: "date", type: "object" },
  {
    label: "a proxy",
    value: ValueProxy.constant(1),
    kind: "proxy",
    type: "object",
  },
  {
    label: "a query",
    value: new Query(QueryStage("table", { id: "t" })),
    kind: "query",
    type: "object",
  },
  {
    label: "a staged object",
    value: new StagedObject(QueryStage("table", { id: "t" })),
    kind: "staged",
    type: "object",
  },
  { label: "a list", value: [1], kind: "list", type: "object" },
  {
    label: "an object literal",
    value: { a: 1 },
    kind: "record",
    type: "object",
  },
  {
    label: "a Buffer",
    value: Buffer.from("a"),
    kind: "opaque",
    type: "object",
  },
  { label: "a Map", value: new Map(), kind: "opaque", type: "object" },
  { label: "a bigint", value: 1n, kind: "opaque", type: "bigint" },
  { label: "a symbol", value: Symbol("s"), kind: "opaque", type: "symbol" },
  { label: "a function", value: () => 1, kind: "opaque", type: "function" },
];

const STAMP: ColumnDescriptor = {
  field: "stamp",
  column: "stamp",
  kind: TEXT,
  family: "text",
  native: "text",
  castType: "text",
  value: (column) => column,
  notNull: false,
  hasDefault: false,
  generated: true,
  identity: "",
};

const WITH_GENERATED: TableModel = {
  fields: { stamp: { column: "stamp", type: TEXT, native: STAMP } },
  external: { schema: "public", table: "t", key: [] },
};

function Split(
  document: Map<string, bigint | Buffer>,
  mode: ExternalWriteMode,
) {
  const view = ClassifyMember(Object.fromEntries(document)).document;
  expect(view).to.not.equal(undefined);
  return view
    ? SplitExternalPayload(
        view,
        WITH_GENERATED,
        new DecodingContext(RefusingCompilers()),
        mode,
      )
    : undefined;
}

interface Cyclic {
  self?: Cyclic;
}

describe("ClassifyMember", () => {
  for (const { label, value, kind, type } of NAMED_KINDS) {
    it(`reads ${label} as ${kind}, refusing it with what typeof answers`, () => {
      const member = ClassifyMember(value);
      expect(member.kind).to.equal(kind);
      expect(() => member.refuseInQuery()).to.throw(
        Error,
        `Unsupported value of type '${type}' in query`,
      );
      expect(() => member.refuseAsId()).to.throw(
        AssertionError,
        `An inserted document's '_id' must be a string, received ${type}`,
      );
    });
  }

  it("looks no deeper than the value, so a cyclic member costs nothing until it is walked", () => {
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const member = ClassifyMember(cyclic);
    expect(member.kind).to.equal("record");
    expect(() => member.json()).to.throw(/circular/);
  });

  it("reads a getter when the walk asks for the entries, each time it asks", () => {
    const reads: string[] = [];
    const member = ClassifyMember({
      get a() {
        reads.push("a");
        return 1;
      },
    });
    expect(reads).to.deep.equal([]);
    member.document?.entries();
    member.document?.entries();
    expect(reads).to.deep.equal(["a", "a"]);
  });

  it("views any non-array object as a document, and nothing else", () => {
    expect(ClassifyMember(Buffer.from("a")).document?.ownNames()).to.include(
      "0",
    );
    expect(ClassifyMember(new Map()).document).to.not.equal(undefined);
    expect(ClassifyMember([1]).document).to.equal(undefined);
    expect(ClassifyMember("x").document).to.equal(undefined);
    expect(ClassifyMember(() => 1).document).to.equal(undefined);
  });

  it("names a non-enumerable own key, as replace's silent fields read it", () => {
    const document = Object.defineProperty({}, "hidden", {
      value: 1,
      enumerable: false,
    });
    expect(ClassifyMember(document).document?.ownNames()).to.deep.equal([
      "hidden",
    ]);
  });

  it("answers an own key and no inherited one", () => {
    const view = ClassifyMember({ own: 1 }).document;
    expect(view?.own("own")?.kind).to.equal("number");
    expect(view?.own("constructor")).to.equal(undefined);
  });

  it("offers a list whole only when every item is json the driver can send", () => {
    const whole = ClassifyMember([1, "a", [true], { b: null }]);
    const stamped = ClassifyMember([new Date(0)]);
    expect(whole.kind === "list" && whole.constant()).to.deep.equal([
      1,
      "a",
      [true],
      { b: null },
    ]);
    expect(stamped.kind === "list" && stamped.constant()).to.equal(undefined);
  });

  it("offers a list whole when an object in it holds an undefined member", () => {
    const holed = ClassifyMember([{ a: undefined }]);
    expect(holed.kind === "list" && holed.constant()).to.deep.equal([
      { a: undefined },
    ]);
  });
});

describe("a key field read as a number, beside _id's text", () => {
  const COUNT: ColumnDescriptor = {
    ...STAMP,
    field: "count",
    column: "count",
    kind: FLOAT,
    family: "float8",
    generated: false,
  };
  const KEYED: TableModel = {
    fields: { count: { column: "count", type: FLOAT, native: COUNT } },
    external: { schema: "public", table: "t", key: [COUNT] },
  };

  function Insert(document: { _id: string; count: number | string }) {
    const view = ClassifyMember(document).document;
    expect(view).to.not.equal(undefined);
    return view
      ? SplitExternalPayload(
          view,
          KEYED,
          new DecodingContext(RefusingCompilers()),
          "insert",
        )
      : undefined;
  }

  it("settles to _id's claim when the number is the one _id spells", () => {
    const split = Insert({ _id: "7", count: 7 });
    expect(split?.keyFields).to.deep.equal([]);
  });

  it("refuses a number that names another key", () => {
    expect(() => Insert({ _id: "7", count: 8 })).to.throw(/two values/);
  });

  it("refuses text where the column's reading is a number", () => {
    expect(() => Insert({ _id: "7", count: "7" })).to.throw(/two values/);
  });
});

describe("what a write keeps to validate before it runs", () => {
  const PLAIN: ColumnDescriptor = { ...STAMP, generated: false };
  const WRITABLE: TableModel = {
    fields: { stamp: { column: "stamp", type: TEXT, native: PLAIN } },
    external: { schema: "public", table: "t", key: [] },
  };
  const COMPILED = { sql: "(1)", type: TEXT };

  function RawOf(document: {
    stamp: string | ValueProxy<string> | Query<string>;
  }) {
    const view = ClassifyMember(document).document;
    expect(view).to.not.equal(undefined);
    const context = new DecodingContext({
      ...RefusingCompilers(),
      expression: () => COMPILED,
      subquery: () => COMPILED,
    });
    return view
      ? SplitExternalPayload(view, WRITABLE, context, "update").assignments[0]
          .raw
      : undefined;
  }

  it("keeps a constant", () => {
    expect(RawOf({ stamp: "x" })?.kind).to.equal("text");
  });

  it("keeps nothing for a value computed from the row", () => {
    expect(RawOf({ stamp: ValueProxy.constant("x") })).to.equal(undefined);
  });

  it("keeps nothing for a subquery", () => {
    expect(
      RawOf({ stamp: new Query(QueryStage("table", { id: "t" })) }),
    ).to.equal(undefined);
  });
});

describe("a value no walk can decode", () => {
  const UNDECODABLE: [string, bigint | Buffer, RegExp][] = [
    ["Buffer", Buffer.from("a"), /'object'/],
    ["bigint", 1n, /'bigint'/],
  ];

  it("refuses a staged object that is neither a proxy nor a query", () => {
    expect(() =>
      DecodeValue(
        ClassifyMember(new StagedObject(QueryStage("table", { id: "t" }))),
        new DecodingContext(RefusingCompilers()),
      ),
    ).to.throw(/'object'/);
  });

  for (const [label, value, refusal] of UNDECODABLE) {
    const document = new Map([["stamp", value]]);

    it(`writes nothing for a ${label} on a generated column of an update`, () => {
      expect(Split(document, "update")?.assignments).to.deep.equal([]);
    });

    it(`writes nothing for a ${label} on a generated column of a replace`, () => {
      expect(Split(document, "replace")?.assignments).to.deep.equal([]);
    });

    it(`refuses a ${label} on a generated column of an insert`, () => {
      expect(() => Split(document, "insert")).to.throw(/stamp/);
    });

    it(`refuses a ${label} when something does decode it`, () => {
      expect(() =>
        DecodeValue(
          ClassifyMember(value),
          new DecodingContext(RefusingCompilers()),
        ),
      ).to.throw(refusal);
    });
  }
});
