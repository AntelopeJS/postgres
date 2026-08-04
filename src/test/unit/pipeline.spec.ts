import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import type { TableShape } from "../../implementations/database/fields";
import {
  ApplyStages,
  DEFERRED_STAGES,
  REJECTED_STAGES,
} from "../../implementations/database/pipeline";
import {
  type Relation,
  TableRelation,
} from "../../implementations/database/relation";
import { TEXT } from "../../implementations/database/types";

const VEHICLES: TableShape = {
  fields: {
    car: { column: "car", type: TEXT },
  },
};

const TABLE = '"shop"."vehicles"';
const ROOT_ALIAS = "t0";
const INHERITED_STAGE = "constructor";
const DEFERRED_STAGE = "join";
const REJECTED_STAGE = "changes";

function NewContext(): DecodingContext {
  return new DecodingContext(
    () => {
      throw new Error("this spec compiles no expression");
    },
    () => {
      throw new Error("this spec compiles no subquery");
    },
  );
}

function NewTable(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, {
    schemaId: "shop",
    tableId: "vehicles",
    shape: VEHICLES,
    index: (name) => [name],
  });
}

function Apply(...names: string[]): Relation {
  return ApplyStages(
    NewTable(),
    names.map((name) => QueryStage(name)),
    NewContext(),
  );
}

describe("ApplyStages", () => {
  it("folds nothing over an empty stage list", () => {
    const relation = NewTable();
    expect(ApplyStages(relation, [], NewContext())).to.equal(relation);
  });

  it("declines a stage named after an inherited member", () => {
    expect(() => Apply(INHERITED_STAGE)).to.throw(
      `Unsupported query stage '${INHERITED_STAGE}'`,
    );
  });

  it("names the stage a deferred message belongs to", () => {
    expect(() => Apply(DEFERRED_STAGE)).to.throw(
      "The PostgreSQL backend does not implement joins yet (stage 'join')",
    );
  });

  it("declines a change feed permanently rather than deferring it", () => {
    expect(() => Apply(REJECTED_STAGE)).to.throw(
      "Change feeds are not supported by the PostgreSQL backend",
    );
  });

  it("prefers the permanent rejection to a deferral of the same name", () => {
    DEFERRED_STAGES[REJECTED_STAGE] = "a deferral that must not win";
    try {
      expect(() => Apply(REJECTED_STAGE)).to.throw(
        REJECTED_STAGES[REJECTED_STAGE],
      );
    } finally {
      delete DEFERRED_STAGES[REJECTED_STAGE];
    }
  });

  it("fails on the first stage it cannot apply", () => {
    expect(() => Apply(REJECTED_STAGE, DEFERRED_STAGE)).to.throw(
      REJECTED_STAGES[REJECTED_STAGE],
    );
  });
});
