import assert from "node:assert";
import { Query } from "../../connection";
import { DecodingContext } from "./context";
import { CloseOneCursor, type CursorRequest, ReadCursorRow } from "./cursors";
import { CompileExpression } from "./expression";
import { CreateInstance, DestroyInstance, ListInstances } from "./instances";
import { ApplyStages, CompileRelation } from "./pipeline";
import {
  OUTPUT_COLUMN,
  type Relation,
  Render,
  RequireOrigin,
} from "./relation";
import { DecodeRow, ReviveValue } from "./result";
import { GetTableNames, WaitForSchemaReady } from "./schema";
import {
  BuildRoot,
  CollectSchemaIds,
  type RootSelection,
  SCHEMA_STAGE,
} from "./selection";
import { CompileSubquery } from "./subquery";
import { CREATE_INSTANCE, DESTROY_INSTANCE, type QueryStage } from "./utils";
import { CompileWrite, SplitWrite, type WriteSplit } from "./writes";
import { type WriteTarget, WriteTargetOf } from "./writes-shared";

type LifecycleHandler = (
  schemaId: string,
  stage: QueryStage,
) => Promise<unknown>;

export type ResultRow = Record<string, unknown>;

/** The root, the terminal write split off after it, and the fold over what was left. */
interface CompiledQuery {
  context: DecodingContext;
  root: RootSelection;
  split: WriteSplit;
  relation: Relation;
}

const MISSING_SCHEMA_ID = "Lifecycle query is missing its schema id";

const LIFECYCLE_STAGE_COUNT = 2;

/** What the driver's nullable `rowCount` means when it declines to count. */
const NO_ROWS = 0;

const LIFECYCLE_HANDLERS: Record<string, LifecycleHandler> = {
  [CREATE_INSTANCE]: (schemaId, stage) =>
    CreateInstance(schemaId, stage.options?.id),
  [DESTROY_INSTANCE]: (schemaId, stage) =>
    DestroyInstance(schemaId, GetTableNames(schemaId), stage.options?.id),
  listInstances: ListInstances,
};

/**
 * Dispatches a schema-rooted instance lifecycle query, or declines it.
 *
 * The stage name is whatever the caller put on the wire, so the handler map is
 * probed with `Object.hasOwn` rather than indexed: a stage named after an
 * inherited `Object.prototype` member would otherwise resolve to a function and
 * be called with a schema id.
 *
 * The gate is awaited here rather than in {@link RunQuery} so the path that
 * declines stays synchronous; the tables the handlers read and write are
 * created by the very registration the gate waits on.
 */
function Lifecycle(stages: QueryStage[]): Promise<unknown> | undefined {
  if (
    stages.length !== LIFECYCLE_STAGE_COUNT ||
    stages[0].stage !== SCHEMA_STAGE
  ) {
    return undefined;
  }
  const stage = stages[1];
  if (!Object.hasOwn(LIFECYCLE_HANDLERS, stage.stage)) {
    return undefined;
  }
  const handler = LIFECYCLE_HANDLERS[stage.stage];
  const schemaId = stages[0].options?.id;
  assert(typeof schemaId === "string", MISSING_SCHEMA_ID);
  return WaitForSchemaReady(schemaId).then(() => handler(schemaId, stage));
}

/**
 * Decodes every row the driver returned, in order and one value per row.
 *
 * Dispatches on the same `projection` discriminator the select list was built from, so the two
 * output modes cannot drift apart, and reads `_id` through `DecodeRow` rather than by enumerating
 * fields, which never carry it (invariant 3).
 *
 * **A cursor decodes through this and never through {@link DecodeResult}**, which is one letter
 * apart in spirit and means something else: the result decoder applies the relation's
 * `single`/`absent` answers, so a `get` that read no row answers `undefined` where a cursor over
 * that same query must be immediately done rather than yield one `undefined`. A `single` relation
 * simply has at most one row to yield and needs no case of its own.
 */
export function DecodeRows(relation: Relation, rows: ResultRow[]): unknown[] {
  const projection = relation.projection;
  if (projection) {
    return rows.map((row) => ReviveValue(row[OUTPUT_COLUMN], projection.type));
  }
  const shape = RequireOrigin(relation).shape;
  return rows.map((row) => DecodeRow(row, shape));
}

/**
 * Turns the driver's rows into what the caller asked for.
 *
 * Decodes them through {@link DecodeRows} and then honours the relation's own answer to whether it
 * yields exactly one row: a single-row relation hands back that row rather than a one-element
 * array, and the absent value the relation itself carries for a read that found nothing.
 *
 * Emptiness is decided by the row count, not by the decoded value being nullish, so a `get` whose
 * row decodes to `null` answers `null` — not the `undefined` that means there is no such row.
 */
export function DecodeResult(relation: Relation, rows: ResultRow[]): unknown {
  const decoded = DecodeRows(relation, rows);
  if (!relation.single) {
    return decoded;
  }
  return decoded.length > 0 ? decoded[0] : relation.absent;
}

async function RunRead(
  relation: Relation,
  context: DecodingContext,
): Promise<unknown> {
  const result = await Query<ResultRow>(Render(relation), context.params.all());
  return DecodeResult(relation, result.rows);
}

/**
 * Executes a terminal write and answers what its stage promised.
 *
 * `insert` knows its keys before the statement runs and answers them in input order; everything
 * else answers the number of rows the statement matched. A compiler that produced no statement had
 * nothing to do, and the answer it already carries is returned without a round trip — asking
 * instead whether that answer is empty would make one compiler's rule the runner's.
 */
async function RunWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): Promise<unknown> {
  const statement = CompileWrite(target, stage, context);
  if (!statement.sql) {
    return statement.ids ?? NO_ROWS;
  }
  const result = await Query(statement.sql, context.params.all());
  return statement.ids ?? result.rowCount ?? NO_ROWS;
}

/** The one production construction of a compiling context, fresh per statement. */
function QueryContext(): DecodingContext {
  return new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
}

/** Root, split, fold — kept apart, and `root` kept visible, because the split runs between them. */
function CompileQuery(
  stages: QueryStage[],
  context: DecodingContext,
): CompiledQuery {
  const root = BuildRoot(stages, context);
  const split = SplitWrite(root.rest);
  const relation = ApplyStages(root.relation, split.pipeline, context);
  return { context, root, split, relation };
}

/** Awaits every schema the stage tree reads, then compiles it in one synchronous pass. */
async function ReadyQuery(
  stages: QueryStage[],
  context: DecodingContext,
): Promise<CompiledQuery> {
  await Promise.all(CollectSchemaIds(stages).map(WaitForSchemaReady));
  return CompileQuery(stages, context);
}

export async function RunQuery(stages: QueryStage[]): Promise<any> {
  const lifecycle = Lifecycle(stages);
  if (lifecycle) {
    return lifecycle;
  }
  const compiled = await ReadyQuery(stages, QueryContext());
  if (!compiled.split.write) {
    return RunRead(compiled.relation, compiled.context);
  }
  return RunWrite(
    WriteTargetOf(compiled.root, compiled.relation),
    compiled.split.write,
    compiled.context,
  );
}

function RefuseCursorWrite(write: QueryStage): never {
  throw new Error(
    `The '${write.stage}' stage writes, so it cannot be read through a cursor`,
  );
}

/**
 * Compiles the relation a cursor declares, or refuses a query that has none to declare.
 *
 * The same root → split → fold `RunQuery` runs, for the same reason it is three steps there: the
 * terminal write is separated *between* the first two, so folding them into `CompileRelation`
 * would hide the root a write target is built from (invariant 25).
 *
 * **A terminal write is refused by name rather than executed.** The write path compiles a
 * *statement* and never renders a relation, so there is nothing for `DECLARE` to hold — and
 * `DECLARE CURSOR` refuses a data-modifying `WITH` outright, which is what an upsert emits.
 * Iterating an `insert` is reachable through the contract's types and means nothing in it, and
 * running it eagerly would put a second execution path in the one place where a retry after a
 * rejected read would run the write twice. `changes` needs nothing here: it is a pipeline stage, so
 * the fold declines it with `REJECTED_STAGES`' permanent message on its own.
 *
 * The context is a parameter rather than built here because the caller decides its lifetime: it
 * carries the parameter ledger the `DECLARE` binds against, and the statement is rendered once and
 * re-used for the whole iteration (invariant 16).
 */
export async function CompileCursor(
  stages: QueryStage[],
  context: DecodingContext,
): Promise<CursorRequest> {
  const compiled = await ReadyQuery(stages, context);
  if (compiled.split.write) {
    RefuseCursorWrite(compiled.split.write);
  }
  const relation = compiled.relation;
  return {
    sql: Render(relation),
    params: context.params.all(),
    decode: (rows) => DecodeRows(relation, rows),
  };
}

export function ReadCursor(
  reqId: number,
  stages: QueryStage[],
): Promise<IteratorResult<any, void>> {
  return ReadCursorRow(reqId, () => CompileCursor(stages, QueryContext()));
}

export function CloseCursor(reqId: number): Promise<void> {
  return CloseOneCursor(reqId);
}
