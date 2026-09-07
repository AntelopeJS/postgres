import assert from "node:assert";

import type { QueryStage } from "./utils";
import { InsertWrite } from "./writes-insert";
import type { DecodingContext } from "./context";
import { DeleteWrite, ReplaceWrite, UpdateWrite } from "./writes-identity";
import type {
  WriteCompiler,
  WriteStatement,
  WriteTarget,
} from "./writes-shared";

/**
 * One terminal stage, and everything the seam has to know about it beyond how to compile it.
 *
 * `readsRelation` is the second fact: a write that ignores the relation may not follow a stage that
 * shaped one. Stating it beside the compiler is what keeps the two answers together — a list of
 * names kept elsewhere is a second place to register a write, and the one that decides whether a
 * pipeline is discarded is not the one a new write is added to.
 */
interface WriteSpec {
  compile: WriteCompiler;
  readsRelation: boolean;
}

export type WriteSpecMap = Record<string, WriteSpec>;

/** A query's pipeline stages, and the terminal write that follows them if there is one. */
export interface WriteSplit {
  pipeline: QueryStage[];
  write?: QueryStage;
}

/**
 * The terminal stages, each compiling a statement that is not a `SELECT`.
 *
 * A plain constant rather than a function: the fragments a write family shares live in
 * `writes-shared.ts`, so nothing a family imports leads back here and the two directions of
 * a require cycle cannot form in either direction. A write is terminal — the contract gives
 * `Query` no chain methods — so no compiler can ever need the dispatch that called it, which is
 * what makes that cut available at all.
 */
export const WRITE_STAGES: WriteSpecMap = {
  insert: { compile: InsertWrite, readsRelation: false },
  update: { compile: UpdateWrite, readsRelation: true },
  replace: { compile: ReplaceWrite, readsRelation: true },
  delete: { compile: DeleteWrite, readsRelation: true },
};

function RefuseWrites(stages: QueryStage[]): void {
  for (const stage of stages) {
    assert(
      !Object.hasOwn(WRITE_STAGES, stage.stage),
      `The '${stage.stage}' stage writes and can only be the last stage of a query`,
    );
  }
}

/**
 * Refuses a write that would silently drop the pipeline it follows, naming every discarded stage.
 * A write that never reads the relation would otherwise ignore every stage before it.
 */
function RefuseDiscardedStages(
  write: QueryStage,
  spec: WriteSpec,
  pipeline: QueryStage[],
): void {
  if (spec.readsRelation || pipeline.length === 0) {
    return;
  }
  const discarded = pipeline.map((stage) => `'${stage.stage}'`).join(", ");
  throw new Error(
    `The '${write.stage}' stage does not read the rows it is applied to, so every stage before it would be discarded: ${discarded}`,
  );
}

/**
 * Separates a query's terminal write from the pipeline that precedes it.
 *
 * A write produces a statement rather than a relation, so it is not a pipeline stage at all and the
 * fold never sees it. The contract makes that split structural — every write returns a `Query`,
 * which has no chain methods — so a write anywhere but last is an error naming it rather than a
 * stage the fold then fails to dispatch. See {@link RefuseDiscardedStages} for the second rule,
 * which the writes that never read the relation additionally answer to.
 */
export function SplitWrite(stages: QueryStage[]): WriteSplit {
  const last = stages[stages.length - 1];
  if (!last || !Object.hasOwn(WRITE_STAGES, last.stage)) {
    RefuseWrites(stages);
    return { pipeline: stages };
  }
  const pipeline = stages.slice(0, -1);
  RefuseWrites(pipeline);
  RefuseDiscardedStages(last, WRITE_STAGES[last.stage], pipeline);
  return { pipeline, write: last };
}

export function CompileWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): WriteStatement {
  assert(
    Object.hasOwn(WRITE_STAGES, stage.stage),
    `Unsupported write stage '${stage.stage}'`,
  );
  return WRITE_STAGES[stage.stage].compile(target, stage, context);
}
