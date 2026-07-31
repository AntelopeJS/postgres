import type { QueryStage } from "@antelopejs/interface-database/common";
import type { DecodingContext } from "./context";
import type { RowSource } from "./row-source";
import type { Compiled } from "./sql";
import { AsValue, type ExpressionState, type StageMap } from "./stage";
import { ARRAY_STAGES } from "./stages-array";
import { CORE_STAGES } from "./stages-core";
import { DATE_STAGES } from "./stages-date";
import { NUMERIC_STAGES } from "./stages-numeric";
import { OBJECT_STAGES } from "./stages-object";
import { STRING_STAGES } from "./stages-string";

export const STAGES: StageMap = {
  ...CORE_STAGES,
  ...NUMERIC_STAGES,
  ...ARRAY_STAGES,
  ...OBJECT_STAGES,
  ...STRING_STAGES,
  ...DATE_STAGES,
};

/**
 * Folds a recorded `ValueProxy` chain into one SQL fragment.
 *
 * `source` seeds the accumulator with the row a lambda is being compiled against, so an
 * expression that opens on `obj_index` reaches a native column rather than a materialized
 * document.
 */
export function CompileExpression(
  stages: QueryStage[],
  context: DecodingContext,
  source?: RowSource,
): Compiled {
  let state: ExpressionState = { current: source };
  for (const stage of stages) {
    if (!Object.hasOwn(STAGES, stage.stage)) {
      throw new Error(`Unsupported expression stage '${stage.stage}'`);
    }
    state = STAGES[stage.stage](state, stage, context);
  }
  return AsValue(state);
}
