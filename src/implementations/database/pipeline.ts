import type { DecodingContext } from "./context";
import type { Relation } from "./relation";
import { AGGREGATE_STAGES } from "./stages-aggregate";
import { PROJECTION_STAGES } from "./stages-projection";
import { ROW_STAGES } from "./stages-rows";
import { SELECTION_STAGES } from "./stages-selection";
import type { QueryStage } from "./utils";

/**
 * One step of the read pipeline: it either absorbs into the relation it is given or wraps it,
 * and every wrap decision goes through `Prepare`.
 */
export type PipelineStage = (
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
) => Relation;

export type PipelineStageMap = Record<string, PipelineStage>;

/**
 * The merged stage vocabulary, built per call rather than at module scope or once.
 *
 * `union` compiles the query it concatenates through {@link ApplyStages}, which makes this module
 * and `stages-rows` mutually dependent. Under CommonJS the module loaded second sees the first
 * one's exports half-written, so merging eagerly drops a whole family from the map — silently,
 * with no error and no failing type — whenever a family module is the one loaded first.
 *
 * Caching the first result would reintroduce exactly that failure with a longer fuse: a future
 * family module that touched this during its own initialization would pin the partial map for the
 * process lifetime. Rebuilding costs one object spread per stage, which is nothing beside the
 * expression compilation the stage is about to do.
 */
export function PipelineStages(): PipelineStageMap {
  return {
    ...ROW_STAGES,
    ...SELECTION_STAGES,
    ...PROJECTION_STAGES,
    ...AGGREGATE_STAGES,
  };
}

function Deferred(feature: string): string {
  return `The PostgreSQL backend does not implement ${feature} yet`;
}

/**
 * Stages this backend will support, named so a caller gets that answer rather than "unknown".
 *
 * A terminal write is never dispatched through the pipeline, so a write this backend does
 * implement leaves this map for `WRITE_STAGES` rather than joining {@link PipelineStages}.
 */
export const DEFERRED_STAGES: Record<string, string> = {
  join: Deferred("joins"),
  lookup: Deferred("lookups"),
  group: Deferred("grouping"),
};

/** Stages this backend declines permanently, with the message it will always give. */
export const REJECTED_STAGES: Record<string, string> = {
  changes: "Change feeds are not supported by the PostgreSQL backend",
};

function StageError(name: string): Error {
  if (Object.hasOwn(REJECTED_STAGES, name)) {
    return new Error(REJECTED_STAGES[name]);
  }
  if (Object.hasOwn(DEFERRED_STAGES, name)) {
    return new Error(`${DEFERRED_STAGES[name]} (stage '${name}')`);
  }
  return new Error(`Unsupported query stage '${name}'`);
}

function ApplyStage(
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
): Relation {
  const stages = PipelineStages();
  if (!Object.hasOwn(stages, stage.stage)) {
    throw StageError(stage.stage);
  }
  return stages[stage.stage](relation, stage, context);
}

/** Folds the pipeline stages that follow a query's root prefix into one relation. */
export function ApplyStages(
  relation: Relation,
  stages: QueryStage[],
  context: DecodingContext,
): Relation {
  return stages.reduce(
    (current, stage) => ApplyStage(current, stage, context),
    relation,
  );
}
