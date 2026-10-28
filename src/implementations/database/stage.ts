import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Compiled } from "./sql";
import { DecodeValue } from "./value";
import type { DecodingContext } from "./context";
import { JsonRowSource, type RowSource } from "./row-source";

/**
 * Accumulator threaded through the stages of one expression.
 *
 * `current` is a {@link RowSource} only while the expression is still addressing a row, which is
 * what lets `obj_index` reach a native column instead of a jsonb path. `timezone` is a pending
 * zone recorded by `date_with_timezone` and consumed by the date-part stages.
 */
export interface ExpressionState {
  current?: Compiled | RowSource;
  timezone?: string;
}

export type StageHandler = (
  state: ExpressionState,
  stage: QueryStage,
  context: DecodingContext,
) => ExpressionState;

export type StageMap = Record<string, StageHandler>;

export type ValueStage = (
  value: Compiled,
  args: readonly (Compiled | undefined)[],
  stage: QueryStage,
  context: DecodingContext,
) => Compiled;

export type RawValueStage = (
  value: Compiled,
  stage: QueryStage,
  context: DecodingContext,
) => Compiled;

export const FIRST_OPERAND = 0;
export const SECOND_OPERAND = 1;

const EMPTY_STATE = "Expression has no value to operate on";

function RequireCurrent(state: ExpressionState): Compiled | RowSource {
  if (!state.current) {
    throw new Error(EMPTY_STATE);
  }
  return state.current;
}

function IsCompiled(current: Compiled | RowSource): current is Compiled {
  return "sql" in current;
}

export function AsValue(state: ExpressionState): Compiled {
  const current = RequireCurrent(state);
  return IsCompiled(current) ? current : current.toJson();
}

export function AsSource(state: ExpressionState): RowSource {
  const current = RequireCurrent(state);
  return IsCompiled(current) ? new JsonRowSource(current) : current;
}

export function RequireOperand(
  value: Compiled | undefined,
  stage: QueryStage,
  index: number,
): Compiled {
  if (!value) {
    throw new Error(
      `Stage '${stage.stage}' requires an operand at position ${index}`,
    );
  }
  return value;
}

/**
 * Reads an argument that is a literal list of field *names* rather than a value.
 *
 * Decoding it instead would bind a parameter no fragment references and produce a jsonb array
 * where an identifier or a `text[]` was wanted, so every stage taking a field list — `obj_has`,
 * `pluck`, `without` — reads it through here and is written as a raw stage.
 */
export function FieldNames(
  stage: QueryStage,
  index: number = FIRST_OPERAND,
): string[] {
  const fields = stage.args[index];
  const named =
    Array.isArray(fields) && fields.every((field) => typeof field === "string");
  if (!named) {
    throw new Error(`Stage '${stage.stage}' requires a list of field names`);
  }
  return fields;
}

/**
 * Adapts a value-level handler into a {@link StageHandler} for a stage whose arguments are all
 * *values*: materializes the accumulator, decodes every argument through `DecodeValue` and drops
 * any pending timezone.
 *
 * A stage whose arguments are not values — `obj_has` takes a `string[]`, `arr_map` and
 * `arr_filter` take a recorded lambda — must use {@link LiftRaw} instead, or `DecodeValue` binds
 * a parameter that no fragment references and the driver rejects the statement for supplying
 * more parameters than the prepared statement takes.
 *
 * Between them the two adapters are what makes a zone recorded by `date_with_timezone` stop
 * applying for the great majority of stages. The handful written as {@link StageHandler}s
 * directly — `arg`, `constant`, `obj_index` and the date readings that consume the zone — each
 * build a fresh state and so drop it too.
 */
export function Lift(handler: ValueStage): StageHandler {
  return (state, stage, context) => {
    const value = AsValue(state);
    const args = stage.args.map((arg) => DecodeValue(arg, context));
    return { current: handler(value, args, stage, context) };
  };
}

/**
 * {@link Lift} for a stage that reads its arguments raw: same materialization and the same
 * timezone clearing, no argument decoding.
 */
export function LiftRaw(handler: RawValueStage): StageHandler {
  return (state, stage, context) => ({
    current: handler(AsValue(state), stage, context),
  });
}

/** Builds one handler per entry of an operator table, so a family declares only its table. */
export function BuildStages<Operator>(
  operators: Record<string, Operator>,
  build: (operator: Operator) => StageHandler,
) {
  const stages: StageMap = {};
  for (const [name, operator] of Object.entries(operators)) {
    stages[name] = build(operator);
  }
  return stages;
}

/**
 * Resolves the field a stage names against a row source, branching on the **raw** argument.
 *
 * A literal name goes to `field`, which resolves a declared field to its own typed column and so
 * keeps `key("price")` reachable by a btree index; only a recorded expression falls through to the
 * dynamic lookup out of a materialized document. The default is a value on both branches and is
 * decoded either way, which is what keeps it a `$n` parameter rather than a literal spliced into
 * the statement.
 */
export function FieldOf(
  source: RowSource,
  stage: QueryStage,
  context: DecodingContext,
): Compiled {
  const def = DecodeValue(stage.args[SECOND_OPERAND], context);
  const name = stage.args[FIRST_OPERAND];
  if (typeof name === "string") {
    return source.field(name, def);
  }
  const key = RequireOperand(DecodeValue(name, context), stage, FIRST_OPERAND);
  return source.dynamicField(key, def);
}
