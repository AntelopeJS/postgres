import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { ApplyRaw } from "./pipeline-fixture";

const COMPOUND_INDEX = "byNameAge";

describe("the get stage", () => {
  it("requires the key, naming the stage", () => {
    expect(() => ApplyRaw([QueryStage("get", undefined)])).to.throw(
      "Stage 'get' requires an operand at position 0",
    );
  });
});

describe("the getAll stage", () => {
  it("reads a null key against a boolean column as no answer, not as false", () => {
    const { relation, context } = ApplyRaw([
      QueryStage("getAll", { index: "isActive" }, null),
    ]);
    expect(relation.where).to.deep.equal([
      `("t0"."isActive" IN ((CASE WHEN jsonb_typeof('null'::jsonb) = 'boolean' THEN (('null'::jsonb #>> '{}')::boolean) END)))`,
    ]);
    expect(context.params.all()).to.deep.equal([]);
  });

  it("reads a document key against a boolean column as no answer, not as true", () => {
    const { relation } = ApplyRaw([
      QueryStage("getAll", { index: "isActive" }, { a: 1 }),
    ]);
    expect(relation.where[0]).to.contain("jsonb_typeof");
    expect(relation.where[0]).to.not.contain("<> ALL");
  });

  it("names the index and the position of a hole inside a compound key", () => {
    expect(() =>
      ApplyRaw([
        QueryStage("getAll", { index: COMPOUND_INDEX }, [["Alice", undefined]]),
      ]),
    ).to.throw(
      "The 'byNameAge' index takes a value for every field, and has none at position 1",
    );
  });
});

describe("the between stage", () => {
  it("requires both bounds, naming the stage and the missing one", () => {
    expect(() =>
      ApplyRaw([QueryStage("between", { index: "age" }, 0)]),
    ).to.throw("Stage 'between' requires an operand at position 1");
    expect(() => ApplyRaw([QueryStage("between", { index: "age" })])).to.throw(
      "Stage 'between' requires an operand at position 0",
    );
  });

  it("requires the field to range over", () => {
    expect(() =>
      ApplyRaw([QueryStage("between", { index: undefined }, 0, 10)]),
    ).to.throw("The 'between' stage is missing its field name");
  });
});
