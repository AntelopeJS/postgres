import { expect } from "chai";

import {
  ArrayOf,
  BOOL,
  FLOAT,
  IsJsonBacked,
  IsOpaque,
  JsonOf,
  OPAQUE,
  PhysicalType,
  ShapeOf,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

describe("SqlType", () => {
  it("maps every kind to a physical type", () => {
    expect(PhysicalType(TEXT)).to.equal("text");
    expect(PhysicalType(FLOAT)).to.equal("double precision");
    expect(PhysicalType(BOOL)).to.equal("boolean");
    expect(PhysicalType(TIMESTAMP)).to.equal("timestamptz");
    expect(PhysicalType(ArrayOf(TEXT))).to.equal("jsonb");
    expect(PhysicalType(OPAQUE)).to.equal("jsonb");
  });

  it("treats only shapeless json as the bottom type", () => {
    expect(IsOpaque(OPAQUE)).to.equal(true);
    expect(IsOpaque(JsonOf({ a: TEXT }))).to.equal(false);
    expect(IsOpaque(TEXT)).to.equal(false);
  });

  it("collapses an empty shape to the bottom type", () => {
    expect(JsonOf(undefined)).to.equal(OPAQUE);
    expect(JsonOf({})).to.equal(OPAQUE);
  });

  it("treats a hand-built empty shape as the bottom type", () => {
    expect(IsOpaque({ kind: "json", shape: {} })).to.equal(true);
  });

  it("reads the members of a shaped json and nothing else", () => {
    expect(ShapeOf(JsonOf({ a: TEXT }))).to.deep.equal({ a: TEXT });
    expect(ShapeOf(OPAQUE)).to.equal(undefined);
    expect(ShapeOf(ArrayOf(TEXT))).to.equal(undefined);
    expect(ShapeOf(TEXT)).to.equal(undefined);
  });

  it("reports jsonb-backed kinds", () => {
    expect(IsJsonBacked(ArrayOf(TEXT))).to.equal(true);
    expect(IsJsonBacked(OPAQUE)).to.equal(true);
    expect(IsJsonBacked(TIMESTAMP)).to.equal(false);
  });
});
