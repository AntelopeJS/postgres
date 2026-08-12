import { CHANGES_STAGE } from "./changes";
import type { DecodingContext } from "./context";
import type { Relation } from "./relation";
import { BuildRoot } from "./selection";
import { AGGREGATE_STAGES } from "./stages-aggregate";
import { GROUP_STAGES } from "./stages-group";
import { JOIN_STAGES } from "./stages-join";
import { PROJECTION_STAGES } from "./stages-projection";
import { ROW_STAGES } from "./stages-rows";
import { SELECTION_STAGES } from "./stages-selection";
import type { QueryStage } from "./utils";
import { SplitWrite } from "./writes";

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
 * The merged stage vocabulary, spread once at module scope.
 *
 * A plain constant rather than a function, exactly as `WRITE_STAGES` is: no family module imports
 * this one at runtime, because a stage that needs a nested query asks the shared context for one
 * through `context.relation` instead of reaching back for {@link CompileRelation}. With no cycle
 * there is no order in which a family can still be half-written when this spread runs, and an
 * eager merge is sound either way round.
 *
 * A family module that imports this one at runtime makes it unsound again, and silently: under
 * CommonJS the spread of a half-written module contributes nothing at all, so the map simply
 * dispatches fewer stages than it names, with no error and no failing type.
 */
export const PIPELINE_STAGES: PipelineStageMap = {
  ...ROW_STAGES,
  ...SELECTION_STAGES,
  ...PROJECTION_STAGES,
  ...AGGREGATE_STAGES,
  ...JOIN_STAGES,
  ...GROUP_STAGES,
};

/**
 * Stages this backend will support, named so a caller gets that answer rather than "unknown".
 *
 * A terminal write is never dispatched through the pipeline, so a write this backend does
 * implement leaves this map for `WRITE_STAGES` rather than joining {@link PIPELINE_STAGES}.
 *
 * Empty, and kept rather than deleted: it is the one door a stage this backend has not built yet
 * leaves through, and the census that reads all four maps is what makes an empty one visible.
 */
export const DEFERRED_STAGES: Record<string, string> = {};

/** Stages this backend declines permanently, with the message it will always give. */
/**
 * Stages this backend refuses permanently, with the message each is refused by.
 *
 * `changes` is here for what reaching the *fold* means rather than for the stage being unsupported:
 * an iterated feed is dispatched by `query.ts` before any compilation, so a `changes` that arrives
 * here is either not the last stage or is being awaited rather than iterated. Awaiting one asks for
 * a finite answer to an unbounded question, and refusing by name is what keeps it from hanging.
 */
export const REJECTED_STAGES: Record<string, string> = {
  [CHANGES_STAGE]:
    "A 'changes' feed must be the last stage of a query and must be iterated rather than awaited",
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
  if (!Object.hasOwn(PIPELINE_STAGES, stage.stage)) {
    throw StageError(stage.stage);
  }
  return PIPELINE_STAGES[stage.stage](relation, stage, context);
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

/**
 * Refuses a nested query that ends in a write, naming the stage rather than the value.
 *
 * A stage array is data by the time it reaches this module, so nothing about the contract's types
 * keeps a write out of a `union`'s argument or out of a document literal — and without this the
 * write reaches {@link ApplyStages} and is declined as `Unsupported query stage 'insert'`, which
 * names the wrong problem: the stage is fully supported and merely cannot be nested.
 */
function RefuseNestedWrite(write: QueryStage): never {
  throw new Error(
    `The '${write.stage}' stage writes, so it cannot be nested inside another query`,
  );
}

/**
 * Compiles a whole query nested inside another one, root prefix and all.
 *
 * The one door to a nested query, wired onto the shared context as `Compilers.relation`: a union's
 * other side and a correlated subquery want the same three steps in the same order — consume the
 * `schema`/`instance`/`table` prefix, refuse a terminal write, fold the rest — and reaching it
 * through the context is what keeps a stage family from importing this module at runtime and
 * rebuilding the require cycle {@link PIPELINE_STAGES} is only a constant without. The edge onto
 * `writes.ts` closes no cycle of its own: nothing that module reaches leads back here.
 *
 * **`RunQuery` does not use it and must not.** It splits a terminal write off *between* the two
 * steps and then compiles it, where this refuses it; and the write target it builds needs
 * `root.instance` — the very fragment the root's predicate bound, which `insert` reuses rather
 * than binding a second parameter for (invariant 25). Folding the two calls together there hides
 * `root` and breaks `insert`'s bind.
 */
export function CompileRelation(
  stages: QueryStage[],
  context: DecodingContext,
): Relation {
  const root = BuildRoot(stages, context);
  const split = SplitWrite(root.rest);
  if (split.write) {
    RefuseNestedWrite(split.write);
  }
  return ApplyStages(root.relation, split.pipeline, context);
}
