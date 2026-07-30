import { expect } from "chai";
import type { TableShape } from "../../implementations/database/fields";
import {
  ColumnRowSource,
  JsonRowSource,
} from "../../implementations/database/row-source";
import {
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

describe("ColumnRowSource", () => {
  it("resolves a declared field to its native column", () => {
    const source = new ColumnRowSource("t", vehicles);
    const out = source.field("price");
    expect(out.sql).to.equal('"t"."price"');
    expect(out.type).to.equal(FLOAT);
  });

  it("routes an undeclared field through _extra", () => {
    const out = new ColumnRowSource("t", vehicles).field("productIds");
    expect(out.sql).to.equal(`("t"."_extra" -> 'productIds')`);
    expect(out.type).to.equal(OPAQUE);
  });

  it("builds the document from the known columns", () => {
    const out = new ColumnRowSource("t", vehicles).toJson();
    expect(out.sql).to.contain("jsonb_strip_nulls(jsonb_build_object(");
    expect(out.sql).to.contain(`'_id', "t"."_id"`);
    expect(out.sql).to.contain(`|| "t"."_extra"`);
    expect(out.sql).to.not.contain("_instance");
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
});
