import { AsJson } from "./readings";
import { WithDefault } from "./coerce";
import { type Compiled, QuoteLiteral } from "./sql";
import { JsonOf, OPAQUE, ShapeOf, type SqlType } from "./types";
import { DecodeFunction, DecodeValue, NULL_JSON } from "./value";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { BuildDocument, type DocumentMember } from "./row-source";
import { ARRAY_TYPEOF, HeldOnce, OBJECT_TYPEOF, TextArray } from "./jsonb";
import { FIRST_OPERAND, FieldNames, FieldOf, RequireOperand } from "./stage";
import {
  CurrentValue,
  Prepare,
  type RelationFlag,
  SetProjection,
} from "./relation";

/**
 * Every projection stage is blocked by a pending projection and by nothing else.
 * Inlining one into the next would square the text; these reshape rows without selecting them.
 */
const PROJECTION_BLOCKERS: readonly RelationFlag[] = ["projection"];

const KEPT_COLUMN = "kept";
const CONTAINER_TYPES = [OBJECT_TYPEOF, ARRAY_TYPEOF]
  .map(QuoteLiteral)
  .join(", ");

const KeyStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  return SetProjection(prepared, FieldOf(prepared.source, stage, context));
};

const DefaultStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const def = DecodeValue(stage.args[FIRST_OPERAND], context) ?? NULL_JSON;
  return SetProjection(prepared, WithDefault(CurrentValue(prepared), def));
};

/**
 * Applies the mapper to each row, binding the relation's own source as its parameter.
 * Binding the source rather than a document is what keeps `map(d => d.key("name"))` a bare column.
 */
const MapStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const body = DecodeFunction(stage.args[FIRST_OPERAND], context, [
    prepared.source,
  ]);
  return SetProjection(prepared, RequireOperand(body, stage, FIRST_OPERAND));
};

/**
 * Builds a document from the named fields alone, through the shared document builder.
 * `_id` is a field like any other here, present only if it was asked for.
 */
const PluckStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const members = FieldNames(stage).map(
    (name): DocumentMember => ({ name, ...prepared.source.field(name) }),
  );
  return SetProjection(prepared, BuildDocument(members));
};

function RemainingType(type: SqlType, removed: readonly string[]): SqlType {
  const shape = ShapeOf(type);
  if (!shape) {
    return OPAQUE;
  }
  const kept = Object.entries(shape).filter(
    ([name]) => !removed.includes(name),
  );
  return JsonOf(Object.fromEntries(kept));
}

/**
 * Removes the named keys from whatever the relation currently yields.
 * A scalar would raise, so the guard excludes it and answers NULL; it reads its operand once.
 */
function Remaining(
  value: Compiled,
  removed: readonly string[],
  alias: string,
): Compiled {
  return {
    sql: HeldOnce({
      value: AsJson(value).sql,
      column: KEPT_COLUMN,
      alias,
      select: (column) => `${column} - ${TextArray(removed)}`,
      guard: (column) => `jsonb_typeof(${column}) IN (${CONTAINER_TYPES})`,
    }),
    type: RemainingType(value.type, removed),
  };
}

const WithoutStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const value = Remaining(
    CurrentValue(prepared),
    FieldNames(stage),
    context.nextAlias(),
  );
  return SetProjection(prepared, value);
};

/** The stages that reshape what each row yields, moving the relation into value mode. */
export const PROJECTION_STAGES: PipelineStageMap = {
  key: KeyStage,
  default: DefaultStage,
  map: MapStage,
  pluck: PluckStage,
  without: WithoutStage,
};
