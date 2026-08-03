import { expect } from "chai";
import {
  IndexName,
  PgIdentifier,
  QualifiedName,
  SchemaName,
  TableName,
  TableReference,
} from "../../implementations/database/identifier";
import { WithOptions } from "./spec-fixture";

const LONG = "a".repeat(100);
const MULTIBYTE = "é".repeat(40);

describe("PgIdentifier", () => {
  it("passes a name that fits through untouched", () => {
    expect(PgIdentifier("orders")).to.equal("orders");
    expect(PgIdentifier("a".repeat(63))).to.equal("a".repeat(63));
  });

  it("truncates and suffixes a name that does not fit", () => {
    const out = PgIdentifier(LONG);
    expect(Buffer.byteLength(out)).to.equal(63);
    expect(out.slice(0, 55)).to.equal("a".repeat(55));
    expect(out.slice(55)).to.match(/^_[0-9a-f]{7}$/);
  });

  it("is deterministic and distinguishes near-identical names", () => {
    expect(PgIdentifier(LONG)).to.equal(PgIdentifier(LONG));
    expect(PgIdentifier(LONG)).to.not.equal(PgIdentifier(`${LONG}b`));
  });

  it("never splits a multi-byte character", () => {
    const out = PgIdentifier(MULTIBYTE);
    expect(Buffer.byteLength(out)).to.be.at.most(63);
    expect(out).to.not.contain("�");
    expect(Buffer.from(out, "utf8").toString("utf8")).to.equal(out);
  });
});

describe("generated names", () => {
  it("prefixes the schema name", () => {
    WithOptions({ schemaPrefix: "app_" }, () => {
      expect(SchemaName("shop")).to.equal("app_shop");
      expect(TableName("orders")).to.equal("orders");
    });
  });

  it("quotes both halves of a qualified name", () => {
    expect(QualifiedName('we"ird', "t")).to.equal('"we""ird"."t"');
  });

  it("joins the table and index ids into an index name", () => {
    expect(IndexName("orders", "customerId")).to.equal("orders_customerId");
    expect(Buffer.byteLength(IndexName(LONG, LONG))).to.equal(63);
  });

  it("resolves a table reference through the configured prefix", () => {
    WithOptions({ schemaPrefix: "app_" }, () => {
      expect(TableReference("shop", "orders")).to.equal('"app_shop"."orders"');
    });
  });
});
