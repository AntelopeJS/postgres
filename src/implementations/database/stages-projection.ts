import { WithDefault } from "./coerce";
import { ARRAY_TYPEOF, HeldOnce, OBJECT_TYPEOF, TextArray } from "./jsonb";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { AsJson } from "./readings";
import {
  CurrentValue,
  Prepare,
  type RelationFlag,
  SetProjection,
} from "./relation";
import { BuildDocument, type DocumentMember } from "./row-source";
import { type Compiled, QuoteLiteral } from "./sql";
import { FIRST_OPERAND, FieldNames, FieldOf, RequireOperand } from "./stage";
import { JsonOf, OPAQUE, ShapeOf, type SqlType } from "./types";
import { DecodeFunction, DecodeValue } from "./value";

/**
 * Every projection stage is blocked by a pending projection and by nothing else.
 *
 * A projection reads its input through the relation's source, which for a shaped member is a
 * guarded expression emitting its operand twice, so inlining one projection into the next would
 * square the text at every step. Wrapping keeps each projection emitted exactly once, in its own
 * subselect level, where the next one reads a plain column. Nothing else blocks these stages:
 * they reshape what a row yields without selecting which rows there are, so a limit, an offset,
 * an ordering or an aggregate ahead of them stays valid and absorbs no further.
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
  const def = RequireOperand(
    DecodeValue(stage.args[FIRST_OPERAND], context),
    stage,
    FIRST_OPERAND,
  );
  return SetProjection(prepared, WithDefault(CurrentValue(prepared), def));
};

/**
 * Applies the mapper to each row, binding the relation's own source as its parameter.
 *
 * Binding the source rather than a materialized document is what lets `map((doc) =>
 * doc.key("name"))` compile to the bare column while the relation is still row-shaped.
 */
const MapStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const body = DecodeFunction(stage.args[FIRST_OPERAND], context, [
    prepared.source,
  ]);
  return SetProjection(prepared, RequireOperand(body, stage, FIRST_OPERAND));
};

/**
 * Builds a document from the named fields alone.
 *
 * It goes through the shared document builder rather than a second `jsonb_build_object` loop
 * precisely so a plucked jsonb-backed field keeps the nulls the caller stored inside it:
 * `jsonb_strip_nulls` recurses, so a member it covers loses them silently. `_id` is a field like
 * any other here — present only if it was asked for, which is what both sibling backends do.
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
 *
 * The container test guards against *failure*, not against a merely surprising answer. Over a
 * jsonb array `-` deletes every element equal to one of the named strings — `'["a","b"]'` minus
 * `array['a']` is `["b"]` — which is not what removing a key means, but it cannot raise, so
 * invariant 14 leaves it to pass rather than paying a `CASE` for it. Over a jsonb scalar, a json
 * null included, it raises `22023 cannot delete from scalar` and loses the whole statement, and
 * that is the one reading the test excludes.
 *
 * The guard reads the value it protects, so it goes through {@link HeldOnce}: a row-mode `without`
 * subtracts from the whole materialized document, and spelling that document a second time inside
 * a `CASE` is the duplication this pipeline's wrap rule exists to avoid.
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
