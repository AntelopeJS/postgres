import { expect } from "chai";
import type { TableShape } from "../../implementations/database/fields";
import {
  ColumnRowSource,
  JsonRowSource,
} from "../../implementations/database/row-source";
import {
  ArrayOf,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const vehicles: TableShape = {
  fields: {
    car: { column: "car", type: TEXT },
    price: { column: "price", type: FLOAT },
    manufactured: { column: "manufactured", type: TIMESTAMP },
  },
};

const catalog: TableShape = {
  fields: {
    car: { column: "car", type: TEXT },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
    tags: { column: "tags", type: ArrayOf(TEXT) },
  },
};

describe("ColumnRowSource", () => {
  it("resolves a declared field to its native column", () => {
    const source = new ColumnRowSource("t", vehicles);
    const out = source.field("price");
    expect(out.sql).to.equal('"t"."price"');
    expect(out.type).to.equal(FLOAT);
  });

  it("resolves the primary key to its own column", () => {
    const out = new ColumnRowSource("t", vehicles).field("_id");
    expect(out.sql).to.equal(`"t"."_id"`);
    expect(out.type).to.equal(TEXT);
  });

  it("routes an undeclared field through _extra", () => {
    const out = new ColumnRowSource("t", vehicles).field("productIds");
    expect(out.sql).to.equal(`("t"."_extra" -> 'productIds')`);
    expect(out.type).to.equal(OPAQUE);
  });

  it("does not resolve keys inherited from Object.prototype", () => {
    const source = new ColumnRowSource("t", vehicles);
    expect(source.field("constructor").sql).to.equal(
      `("t"."_extra" -> 'constructor')`,
    );
    expect(source.field("constructor").type).to.equal(OPAQUE);
    expect(source.field("__proto__").sql).to.equal(
      `("t"."_extra" -> '__proto__')`,
    );
    expect(source.field("hasOwnProperty").type).to.equal(OPAQUE);
  });

  it("builds the document from the known columns", () => {
    const out = new ColumnRowSource("t", vehicles).toJson();
    expect(out.sql).to.contain("jsonb_strip_nulls(jsonb_build_object(");
    expect(out.sql).to.contain(`'_id', "t"."_id"`);
    expect(out.sql).to.contain(`|| COALESCE("t"."_extra", '{}'::jsonb)`);
    expect(out.sql).to.not.contain("_instance");
  });

  it("tolerates a NULL _extra rather than nulling the whole document", () => {
    const out = new ColumnRowSource("t", vehicles).toJson();
    expect(out.sql).to.contain(`COALESCE("t"."_extra", '{}'::jsonb)`);
    expect(out.sql).to.not.contain(`|| "t"."_extra")`);
  });

  it("keeps declared jsonb columns out of jsonb_strip_nulls", () => {
    const out = new ColumnRowSource("t", catalog).toJson();
    expect(out.sql).to.contain(
      `jsonb_strip_nulls(jsonb_build_object('_id', "t"."_id", 'car', "t"."car"))`,
    );
    expect(out.sql).to.contain(
      `(CASE WHEN "t"."metadata" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('metadata', "t"."metadata") END)`,
    );
    expect(out.sql).to.contain(
      `(CASE WHEN "t"."tags" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('tags', "t"."tags") END)`,
    );
  });

  it("exposes a shape including the primary key", () => {
    expect(new ColumnRowSource("t", vehicles).shape()).to.deep.equal({
      _id: TEXT,
      car: TEXT,
      price: FLOAT,
      manufactured: TIMESTAMP,
    });
  });
});

describe("JsonRowSource", () => {
  it("casts a shaped field out of jsonb", () => {
    const source = new JsonRowSource({
      sql: "v",
      type: JsonOf({ price: FLOAT }),
    });
    expect(source.field("price").sql).to.equal(
      "(((v -> 'price') #>> '{}')::double precision)",
    );
  });

  it("leaves an unshaped field opaque", () => {
    const source = new JsonRowSource({ sql: "v", type: OPAQUE });
    const out = source.field("whatever");
    expect(out.sql).to.equal("(v -> 'whatever')");
    expect(out.type).to.equal(OPAQUE);
  });

  it("does not read a field type inherited from Object.prototype", () => {
    const source = new JsonRowSource({
      sql: "v",
      type: JsonOf({ price: FLOAT }),
    });
    const out = source.field("constructor");
    expect(out.sql).to.equal("(v -> 'constructor')");
    expect(out.type).to.equal(OPAQUE);
    expect(source.field("__proto__").sql).to.equal("(v -> '__proto__')");
    expect(source.field("__proto__").type).to.equal(OPAQUE);
  });

  it("coerces a non-jsonb value before indexing into it", () => {
    const source = new JsonRowSource({ sql: "t.name", type: TEXT });
    expect(source.field("x").sql).to.equal("(to_jsonb(t.name) -> 'x')");
    expect(source.dynamicField({ sql: "$1", type: TEXT }).sql).to.equal(
      "(to_jsonb(t.name) -> $1)",
    );
  });
});
