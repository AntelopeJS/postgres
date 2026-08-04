import { expect } from "chai";
import type { TableShape } from "../../implementations/database/fields";
import { DecodeResult } from "../../implementations/database/query";
import {
  type Relation,
  SetProjection,
  type TableOrigin,
  TableRelation,
} from "../../implementations/database/relation";
import { FLOAT, TEXT } from "../../implementations/database/types";

const PEOPLE: TableShape = {
  fields: {
    name: { column: "name", type: TEXT },
    age: { column: "age", type: FLOAT },
  },
};

const TABLE = '"directory"."people"';
const ROOT_ALIAS = "t0";

const ALICE = { _id: "a", _instance: "", name: "Alice", age: 30, _extra: null };
const BOB = { _id: "b", _instance: "", name: "Bob", age: 41, _extra: null };

function NewOrigin(): TableOrigin {
  return {
    schemaId: "directory",
    tableId: "people",
    shape: PEOPLE,
    index: (name) => [name],
  };
}

function RowMode(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, NewOrigin());
}

function ValueMode(): Relation {
  return SetProjection(RowMode(), { sql: '"t0"."name"', type: TEXT });
}

describe("DecodeResult in row mode", () => {
  it("decodes every row against the table's shape", () => {
    expect(DecodeResult(RowMode(), [ALICE, BOB])).to.deep.equal([
      { _id: "a", name: "Alice", age: 30 },
      { _id: "b", name: "Bob", age: 41 },
    ]);
  });

  it("hands back the row itself when the relation yields exactly one", () => {
    const relation = RowMode();
    relation.single = true;
    expect(DecodeResult(relation, [ALICE])).to.deep.equal({
      _id: "a",
      name: "Alice",
      age: 30,
    });
  });

  it("decodes an empty single-row read as null rather than undefined", () => {
    const relation = RowMode();
    relation.single = true;
    expect(DecodeResult(relation, [])).to.equal(null);
  });

  it("decodes an empty stream as an empty array", () => {
    expect(DecodeResult(RowMode(), [])).to.deep.equal([]);
  });

  it("answers the relation's own absent value, which get sets to undefined", () => {
    const relation = RowMode();
    relation.single = true;
    relation.absent = undefined;
    expect(DecodeResult(relation, [])).to.equal(undefined);
  });
});

describe("DecodeResult in value mode", () => {
  it("revives the output column against the projection's type", () => {
    expect(DecodeResult(ValueMode(), [{ value: "Alice" }])).to.deep.equal([
      "Alice",
    ]);
  });

  it("hands back the value itself when the relation yields exactly one", () => {
    const relation = ValueMode();
    relation.single = true;
    expect(DecodeResult(relation, [{ value: "Alice" }])).to.equal("Alice");
  });

  it("decodes an empty single-row read as null rather than undefined", () => {
    const relation = ValueMode();
    relation.single = true;
    expect(DecodeResult(relation, [])).to.equal(null);
  });

  it("keeps a NULL output column as null, which is what nth past the end is", () => {
    const relation = ValueMode();
    relation.single = true;
    expect(DecodeResult(relation, [{ value: null }])).to.equal(null);
  });

  it("distinguishes a row that decoded to null from a read that found none", () => {
    const relation = ValueMode();
    relation.single = true;
    relation.absent = undefined;
    expect(DecodeResult(relation, [{ value: null }])).to.equal(null);
    expect(DecodeResult(relation, [])).to.equal(undefined);
  });
});
