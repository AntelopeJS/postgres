import { expect } from "chai";

import type { TableShape } from "../../implementations/database/fields";
import { DecodeRow, ReviveValue } from "../../implementations/database/result";
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

describe("ReviveValue", () => {
  it("revives an ISO string at a timestamp leaf", () => {
    const out = ReviveValue("2003-01-01T00:00:00+00:00", TIMESTAMP);
    expect(out).to.be.a("date");
    expect((out as Date).getTime()).to.equal(
      new Date("2003-01-01T00:00:00Z").getTime(),
    );
  });

  it("passes a Date through untouched", () => {
    const date = new Date();
    expect(ReviveValue(date, TIMESTAMP)).to.equal(date);
  });

  it("walks a shape and leaves unshaped branches alone", () => {
    const type = JsonOf({ at: TIMESTAMP, tags: ArrayOf(TEXT), blob: OPAQUE });
    const out = ReviveValue(
      {
        at: "2020-01-01T00:00:00Z",
        tags: ["a"],
        blob: { nested: "x" },
        extra: 1,
      },
      type,
    ) as Record<string, unknown>;
    expect(out.at).to.be.a("date");
    expect(out.tags).to.deep.equal(["a"]);
    expect(out.blob).to.deep.equal({ nested: "x" });
    expect(out.extra).to.equal(1);
  });

  it("revives ISO strings inside a jsonb array of timestamps", () => {
    const out = ReviveValue(
      ["2020-01-01T00:00:00Z", "2021-06-02T12:30:00Z"],
      ArrayOf(TIMESTAMP),
    ) as Date[];
    expect(out).to.be.an("array").of.length(2);
    expect(out[0]).to.be.a("date");
    expect(out[0].getTime()).to.equal(
      new Date("2020-01-01T00:00:00Z").getTime(),
    );
    expect(out[1].getTime()).to.equal(
      new Date("2021-06-02T12:30:00Z").getTime(),
    );
  });

  it("does not mutate the value it revives", () => {
    const value = { at: "2020-01-01T00:00:00Z" };
    const out = ReviveValue(value, JsonOf({ at: TIMESTAMP })) as Record<
      string,
      unknown
    >;
    expect(value.at).to.equal("2020-01-01T00:00:00Z");
    expect(out).to.not.equal(value);
    expect(out.at).to.be.a("date");
  });

  it("revives epoch milliseconds at a timestamp leaf", () => {
    const out = ReviveValue(1712345678000, TIMESTAMP);
    expect(out).to.be.a("date");
    expect((out as Date).getTime()).to.equal(1712345678000);
  });

  it("leaves an unparseable timestamp untouched", () => {
    expect(ReviveValue("not a date", TIMESTAMP)).to.equal("not a date");
    const blob = { a: 1 };
    expect(ReviveValue(blob, TIMESTAMP)).to.equal(blob);
  });

  it("passes null and undefined through", () => {
    expect(ReviveValue(null, TIMESTAMP)).to.equal(null);
    expect(ReviveValue(undefined, TIMESTAMP)).to.equal(undefined);
  });
});

describe("DecodeRow", () => {
  it("merges _extra over the declared columns and drops nulls", () => {
    const row = {
      _id: "a",
      car: "Peugeot",
      price: null,
      _extra: { productIds: ["p1"] },
    };
    expect(DecodeRow(row, vehicles)).to.deep.equal({
      _id: "a",
      car: "Peugeot",
      productIds: ["p1"],
    });
  });

  it("does not invent an _id on a projected row", () => {
    expect(DecodeRow({ car: "X" }, vehicles)).to.deep.equal({ car: "X" });
  });

  it("carries the instance a named-instance row came from", () => {
    const row = { _id: "a", _instance: "tenant-7", car: "Peugeot" };
    expect(DecodeRow(row, vehicles)).to.deep.equal({
      _id: "a",
      _instance: "tenant-7",
      car: "Peugeot",
    });
  });

  it("carries no instance for the default one, which is stored as the empty string", () => {
    const row = { _id: "a", _instance: "", car: "Peugeot" };
    expect(DecodeRow(row, vehicles)).to.deep.equal({
      _id: "a",
      car: "Peugeot",
    });
  });

  it("does not let a stale _extra._instance shadow the instance column", () => {
    const row = {
      _id: "a",
      _instance: "tenant-7",
      _extra: { _instance: "stale" },
    };
    expect(DecodeRow(row, vehicles)).to.deep.equal({
      _id: "a",
      _instance: "tenant-7",
    });
  });

  it("does not let a stale _extra._id shadow the primary key", () => {
    const row = { _id: "real", _extra: { _id: "stale", productIds: ["p1"] } };
    expect(DecodeRow(row, vehicles)).to.deep.equal({
      _id: "real",
      productIds: ["p1"],
    });
  });

  it("revives declared columns and tolerates a missing _extra", () => {
    const row = {
      _id: "b",
      car: "Renault",
      manufactured: "1998-04-05T00:00:00Z",
    };
    const out = DecodeRow(row, vehicles);
    expect(out._id).to.equal("b");
    expect(out.car).to.equal("Renault");
    expect(out.manufactured).to.be.a("date");
    expect((out.manufactured as Date).getTime()).to.equal(
      new Date("1998-04-05T00:00:00Z").getTime(),
    );
  });
});
