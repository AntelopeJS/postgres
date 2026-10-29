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
  KeyTypesOf,
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

  it("separates a shape that is empty from one that is unknown", () => {
    expect(JsonOf(undefined)).to.equal(OPAQUE);
    expect(JsonOf({})).to.deep.equal({ kind: "json", keys: {} });
  });

  it("calls only an absent shape the bottom type", () => {
    expect(IsOpaque({ kind: "json", keys: {} })).to.equal(false);
    expect(IsOpaque(OPAQUE)).to.equal(true);
  });

  it("reads the members of a shaped json and nothing else", () => {
    expect(KeyTypesOf(JsonOf({ a: TEXT }))).to.deep.equal({ a: TEXT });
    expect(KeyTypesOf(OPAQUE)).to.equal(undefined);
    expect(KeyTypesOf(ArrayOf(TEXT))).to.equal(undefined);
    expect(KeyTypesOf(TEXT)).to.equal(undefined);
  });

  it("reports jsonb-backed kinds", () => {
    expect(IsJsonBacked(ArrayOf(TEXT))).to.equal(true);
    expect(IsJsonBacked(OPAQUE)).to.equal(true);
    expect(IsJsonBacked(TIMESTAMP)).to.equal(false);
  });
});
