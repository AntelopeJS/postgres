import type { QueryStage } from "@antelopejs/interface-database/common";

import { RefusingCompilers } from "./spec-fixture";
import { TEXT } from "../../implementations/database/types";
import type { TableModel } from "../../implementations/database/fields";
import { DecodingContext } from "../../implementations/database/context";
import {
  type Relation,
  TableRelation,
} from "../../implementations/database/relation";
import {
  ApplyStages,
  DEFERRED_STAGES,
} from "../../implementations/database/pipeline";

const VEHICLES: TableModel = {
  fields: {
    car: { column: "car", type: TEXT },
  },
};

const TABLE = '"shop"."vehicles"';
const ROOT_ALIAS = "t0";

export const REJECTED_STAGE = "changes";

/**
 * A deferral installed by the spec rather than read off the map, which no longer carries one.
 *
 * Every stage the contract records is now dispatched or permanently declined, so the deferred
 * branch is reachable only from a map this spec writes to — the same door the precedence case
 * beside it already uses.
 */
export const DEFERRED_STAGE = "someStageThisBackendHasNotBuilt";
export const DEFERRAL =
  "The PostgreSQL backend does not implement something yet";

export function WithDeferral<T>(name: string, read: () => T): T {
  DEFERRED_STAGES[name] = DEFERRAL;
  try {
    return read();
  } finally {
    delete DEFERRED_STAGES[name];
  }
}

export function NewContext(): DecodingContext {
  return new DecodingContext(RefusingCompilers());
}

export function NewTable(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, {
    schemaId: "shop",
    tableId: "vehicles",
    model: VEHICLES,
    index: (name) => [name],
  });
}

export function Apply(...stages: QueryStage[]): Relation {
  return ApplyStages(NewTable(), stages, NewContext());
}
