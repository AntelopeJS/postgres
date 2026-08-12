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
import { RefusingCompilers } from "./spec-fixture";

const VEHICLES: TableShape = {
  fields: {
    car: { column: "car", type: TEXT },
  },
};

const TABLE = '"shop"."vehicles"';
const ROOT_ALIAS = "t0";
const INHERITED_STAGE = "constructor";
const REJECTED_STAGE = "changes";

/**
 * A deferral installed by the spec rather than read off the map, which no longer carries one.
 *
 * Every stage the contract records is now dispatched or permanently declined, so the deferred
 * branch is reachable only from a map this spec writes to — the same door the precedence case
 * beside it already uses.
 */
const DEFERRED_STAGE = "someStageThisBackendHasNotBuilt";
const DEFERRAL = "The PostgreSQL backend does not implement something yet";

function WithDeferral<T>(name: string, read: () => T): T {
  DEFERRED_STAGES[name] = DEFERRAL;
  try {
    return read();
  } finally {
    delete DEFERRED_STAGES[name];
  }
}

function NewContext(): DecodingContext {
  return new DecodingContext(RefusingCompilers());
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
    WithDeferral(DEFERRED_STAGE, () => {
      expect(() => Apply(DEFERRED_STAGE)).to.throw(
        `${DEFERRAL} (stage '${DEFERRED_STAGE}')`,
      );
    });
  });

  it("defers nothing, now that every stage is dispatched or declined", () => {
    expect(Object.keys(DEFERRED_STAGES)).to.deep.equal([]);
  });

  it("declines a change feed that reached the fold, which is one not last or one awaited", () => {
    expect(() => Apply(REJECTED_STAGE)).to.throw(
      "must be the last stage of a query and must be iterated rather than awaited",
    );
  });

  it("prefers the permanent rejection to a deferral of the same name", () => {
    WithDeferral(REJECTED_STAGE, () => {
      expect(() => Apply(REJECTED_STAGE)).to.throw(
        REJECTED_STAGES[REJECTED_STAGE],
      );
    });
  });

  it("fails on the first stage it cannot apply", () => {
    expect(() => Apply(REJECTED_STAGE, DEFERRED_STAGE)).to.throw(
      REJECTED_STAGES[REJECTED_STAGE],
    );
  });
});
