import { expect } from "chai";

import { FLOAT, OPAQUE } from "../../implementations/database/types";
import {
  Param,
  ParamCollector,
  QuoteIdentifier,
  QuoteLiteral,
} from "../../implementations/database/sql";

describe("sql", () => {
  it("numbers parameters sequentially", () => {
    const params = new ParamCollector();
    expect(params.add("a")).to.equal("$1");
    expect(params.add("b")).to.equal("$2");
    expect(params.all()).to.deep.equal(["a", "b"]);
  });

  it("escapes identifiers and literals", () => {
    expect(QuoteIdentifier('we"ird')).to.equal('"we""ird"');
    expect(QuoteLiteral("o'brien")).to.equal("'o''brien'");
  });

  it("escapes backslashes independently of standard_conforming_strings", () => {
    expect(QuoteLiteral("a\\")).to.equal("E'a\\\\'");
    expect(QuoteLiteral("a\\'b")).to.equal("E'a\\\\''b'");
  });

  it("rejects NUL bytes rather than truncating the statement", () => {
    expect(() => QuoteLiteral("a\0b")).to.throw(/NUL/);
    expect(() => QuoteIdentifier("a\0b")).to.throw(/NUL/);
  });

  it("casts scalar parameters to their physical type", () => {
    const params = new ParamCollector();
    expect(Param(params, 12, FLOAT).sql).to.equal("($1::double precision)");
    expect(params.all()).to.deep.equal([12]);
  });

  it("serialises json-backed parameters", () => {
    const params = new ParamCollector();
    const compiled = Param(params, { a: 1 }, OPAQUE);
    expect(compiled.sql).to.equal("($1::jsonb)");
    expect(params.all()).to.deep.equal(['{"a":1}']);
    expect(compiled.type).to.equal(OPAQUE);
  });
});
