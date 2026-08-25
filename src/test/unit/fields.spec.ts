import type { FieldType } from "@antelopejs/interface-database/schema";
import { expect } from "chai";
import {
  DocumentKeys,
  ParseFieldType,
  ParseTable,
} from "../../implementations/database/fields";
import { PgIdentifier } from "../../implementations/database/identifier";
import {
  ArrayOf,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

describe("ParseFieldType", () => {
  it("accepts the token set case-insensitively", () => {
    expect(ParseFieldType("string", "t.f").type).to.equal(TEXT);
    expect(ParseFieldType("Date", "t.f").type).to.equal(TIMESTAMP);
    expect(ParseFieldType("date", "t.f").type).to.equal(TIMESTAMP);
    expect(ParseFieldType("number", "t.f").type).to.equal(FLOAT);
    expect(ParseFieldType("object", "t.f").type).to.equal(OPAQUE);
  });

  it("accepts both array spellings", () => {
    expect(ParseFieldType("string[]", "t.f").type).to.deep.equal(ArrayOf(TEXT));
    expect(ParseFieldType(["string"], "t.f").type).to.deep.equal(ArrayOf(TEXT));
    expect(ParseFieldType("object[]", "t.f").type).to.deep.equal(
      ArrayOf(OPAQUE),
    );
  });

  it("parses a nested record into a shape", () => {
    const parsed = ParseFieldType(
      { level: "number", tags: "string[]" },
      "t.metadata",
    );
    expect(parsed.type).to.deep.equal(
      JsonOf({ level: FLOAT, tags: ArrayOf(TEXT) }),
    );
  });

  it("detects an io-ts codec structurally", () => {
    const codec = {
      name: "X",
      is: () => true,
      encode: (v: never) => v,
      decode: (v: unknown) => v,
    };
    const parsed = ParseFieldType(codec as unknown as FieldType, "t.status");
    expect(parsed.type).to.equal(OPAQUE);
    expect(parsed.codec).to.equal(codec);
  });

  it("rejects an unknown token, naming the field", () => {
    expect(() => ParseFieldType("uuid", "shop.orders.ref")).to.throw(
      /shop\.orders\.ref/,
    );
    expect(() => ParseFieldType("uuid", "shop.orders.ref")).to.throw(/uuid/);
  });

  it("rejects tokens inherited from Object.prototype", () => {
    expect(() => ParseFieldType("constructor", "t.f")).to.throw(
      /Unsupported field type/,
    );
    expect(() => ParseFieldType("__proto__", "t.f")).to.throw(
      /Unsupported field type/,
    );
    expect(() => ParseFieldType("valueOf", "t.f")).to.throw(
      /Unsupported field type/,
    );
  });

  it("rejects a declaration that is neither a string, array nor object", () => {
    expect(() => ParseFieldType(null as unknown as FieldType, "t.f")).to.throw(
      /Unsupported field type/,
    );
    expect(() => ParseFieldType(123 as unknown as FieldType, "t.f")).to.throw(
      /Unsupported field type/,
    );
    expect(() =>
      ParseFieldType(undefined as unknown as FieldType, "t.f"),
    ).to.throw(/Unsupported field type/);
  });
});

describe("ParseTable", () => {
  it("rejects the reserved columns a schema may not declare", () => {
    expect(() =>
      ParseTable(
        { fields: { _instance: "string" }, indexes: {} },
        "shop.orders",
      ),
    ).to.throw(/_instance/);
    expect(() =>
      ParseTable({ fields: { _extra: "string" }, indexes: {} }, "shop.orders"),
    ).to.throw(/_extra/);
  });

  it("accepts a declared key column, which restates it rather than adding one", () => {
    const shape = ParseTable(
      { fields: { _id: "string", price: "number" }, indexes: {} },
      "shop.orders",
    );
    expect(Object.keys(shape.fields)).to.deep.equal(["price"]);
    expect(DocumentKeys(shape)).to.deep.equal(["_id", "_instance", "price"]);
  });

  it("refuses a declared key column the key could not be", () => {
    expect(() =>
      ParseTable({ fields: { _id: "number" }, indexes: {} }, "shop.orders"),
    ).to.throw(
      "Field '_id' on 'shop.orders' restates the adapter's key column and must be declared 'string'",
    );
  });

  it("fits an oversized field name into a column name", () => {
    const name = "n".repeat(100);
    const shape = ParseTable(
      { fields: { name: "string" }, indexes: {} },
      "shop.orders",
    );
    expect(shape.fields.name.column).to.equal("name");

    const long = ParseTable(
      { fields: { [name]: "string" }, indexes: {} },
      "shop.orders",
    );
    expect(long.fields[name].column).to.equal(PgIdentifier(name));
    expect(long.fields[name].column).to.not.equal(name);
  });

  it("rejects two fields that collide on one column", () => {
    const name = "c".repeat(100);
    expect(() =>
      ParseTable(
        {
          fields: { [name]: "string", [PgIdentifier(name)]: "string" },
          indexes: {},
        },
        "shop.orders",
      ),
    ).to.throw(/both map to column/);
  });
});
