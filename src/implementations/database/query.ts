import assert from "node:assert";
import { ValidateAtomicMutationTable } from "@antelopejs/interface-database/atomic";

import { Query } from "../../connection";
import { IsExternal } from "../../config";
import {
  ExternalInstanceRefusal,
  ExternalWriteRefusal,
} from "./external-refusals";
import { CHANGES_STAGE } from "./changes";
import type { ExternalRelation } from "./fields";
import { ExternalWriteFailure, InvalidValues } from "./external-errors";
import { DecodingContext } from "./context";
import { CompileSubquery } from "./subquery";
import { CompileExpression } from "./expression";
import { DecodeRow, ReviveValue } from "./result";
import { ApplyStages, CompileRelation } from "./pipeline";
import { DuplicateKeyFailure } from "./duplicate-key";
import {
  GetTableNames,
  WaitForSchemaReady,
  WaitForUniqueIndexes,
} from "./schema";
import {
  type WriteStatement,
  type WriteTarget,
  WriteTargetOf,
  type WriteValidation,
} from "./writes-shared";
import { CompileWrite, SplitWrite, type WriteSplit } from "./writes";
import { ATOMIC_MUTATION, ExecuteAtomicWrite } from "./writes-atomic";
import { CloseOneFeed, IsRegisteredFeed, ReadFeedEvent } from "./feeds";
import { CreateInstance, DestroyInstance, ListInstances } from "./instances";
import {
  CREATE_INSTANCE,
  DESTROY_INSTANCE,
  ID_COLUMN,
  type QueryStage,
} from "./utils";
import { CloseOneCursor, type CursorRequest, ReadCursorRow } from "./cursors";
import { OUTPUT_COLUMN, type Relation, RequireOrigin } from "./relation";
import { Render } from "./render";
import {
  BuildRoot,
  CollectSchemaIds,
  type RootSelection,
  SCHEMA_STAGE,
} from "./selection";
import { IsString } from "./guards";

type LifecycleAnswer = string | string[] | void;

type LifecycleHandler = (
  schemaId: string,
  stage: QueryStage,
) => Promise<LifecycleAnswer>;

type WriteAnswer =
  | string[]
  | number
  | unknown[]
  | Awaited<ReturnType<typeof ExecuteAtomicWrite>>;

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

const LIFECYCLE_HANDLERS = {
  [CREATE_INSTANCE]: (schemaId, stage) =>
    CreateInstance(schemaId, stage.options?.id),
  [DESTROY_INSTANCE]: (schemaId, stage) =>
    DestroyInstance(schemaId, GetTableNames(schemaId), stage.options?.id),
  listInstances: ListInstances,
} satisfies Record<string, LifecycleHandler>;

function IsLifecycleStage(
  name: string,
): name is keyof typeof LIFECYCLE_HANDLERS {
  return Object.hasOwn(LIFECYCLE_HANDLERS, name);
}

/**
 * The lifecycle stages on an external instance, whose relations have no instances: creating or
 * destroying one is refused rather than recorded nowhere, and the list of them is empty.
 */
const EXTERNAL_LIFECYCLE = {
  [CREATE_INSTANCE]: (_schemaId, stage) =>
    Promise.reject(ExternalInstanceRefusal(stage.stage)),
  [DESTROY_INSTANCE]: (_schemaId, stage) =>
    Promise.reject(ExternalInstanceRefusal(stage.stage)),
  listInstances: () => Promise.resolve([]),
} satisfies Record<keyof typeof LIFECYCLE_HANDLERS, LifecycleHandler>;

/**
 * Dispatches a schema-rooted instance lifecycle query, or declines it synchronously.
 * The map is probed with `Object.hasOwn`, and the gate is awaited here rather than in `RunQuery`.
 */
function Lifecycle(stages: QueryStage[]): Promise<LifecycleAnswer> | undefined {
  if (
    stages.length !== LIFECYCLE_STAGE_COUNT ||
    stages[0].stage !== SCHEMA_STAGE
  ) {
    return undefined;
  }
  const stage = stages[1];
  if (!IsLifecycleStage(stage.stage)) {
    return undefined;
  }
  const handler = (IsExternal() ? EXTERNAL_LIFECYCLE : LIFECYCLE_HANDLERS)[
    stage.stage
  ];
  const schemaId = stages[0].options?.id;
  assert(IsString(schemaId), MISSING_SCHEMA_ID);
  return WaitForSchemaReady(schemaId).then(() => handler(schemaId, stage));
}

/**
 * Decodes every row the driver returned, in order and one value per row.
 *
 * Dispatches on the same `projection` discriminator the select list was built from, so the two
 * output modes cannot drift apart, and reads `_id` through `DecodeRow` rather than by enumerating
 * fields, which never carry it.
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
  const model = RequireOrigin(relation).model;
  return rows.map((row) => DecodeRow(row, model));
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
 * `insert` answers its keys in input order; everything else answers the rows it matched.
 * A managed write waits for the unique indexes it is checked against, see `WaitForUniqueIndexes`.
 */
async function RunWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): Promise<WriteAnswer> {
  const statement = CompileWrite(target, stage, context);
  if (!statement.sql) {
    return statement.ids ?? NO_ROWS;
  }
  const external = target.origin.model.external;
  if (external) {
    return RunExternalWrite(statement, external, context);
  }
  await WaitForUniqueIndexes(target.origin.schemaId);
  try {
    return await RunManagedWrite(statement, stage, context);
  } catch (err) {
    throw await DuplicateKeyFailure(err, target.origin);
  }
}

/** A write to a table the adapter manages, before its failure is reported. */
async function RunManagedWrite(
  statement: WriteStatement,
  stage: QueryStage,
  context: DecodingContext,
): Promise<WriteAnswer> {
  if (stage.stage === ATOMIC_MUTATION) {
    return ExecuteAtomicWrite(statement.sql, context.params.all());
  }
  const result = await Query(statement.sql, context.params.all());
  return statement.ids ?? result.rowCount ?? NO_ROWS;
}

/** Refuses the write, naming every field, when any value failed its check; runs nothing otherwise. */
async function Validate(
  validation: WriteValidation | undefined,
): Promise<void> {
  if (!validation) {
    return;
  }
  const result = await Query<Record<string, boolean>>(
    validation.sql,
    validation.params,
  );
  const row = result.rows[0] ?? {};
  const failed = validation.failures.filter(
    (_, index) => row[`c${index}`] !== true,
  );
  if (failed.length > 0) {
    throw InvalidValues(failed);
  }
}

/**
 * A write to an external relation: its values checked first, its keys answered off `RETURNING`,
 * and a constraint the database enforces reported as what it is rather than as a SQLSTATE.
 */
async function RunExternalWrite(
  statement: WriteStatement,
  external: ExternalRelation,
  context: DecodingContext,
): Promise<WriteAnswer> {
  await Validate(statement.validation);
  try {
    const result = await Query<ResultRow>(statement.sql, context.params.all());
    if (statement.returnsIds) {
      return result.rows.map((row) => row[ID_COLUMN]);
    }
    return result.rowCount ?? NO_ROWS;
  } catch (err) {
    throw ExternalWriteFailure(err, external);
  }
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
  if (stages.at(-1)?.stage === ATOMIC_MUTATION) {
    ValidateAtomicMutationTable(stages.slice(0, -1));
  }
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
  if (
    compiled.root.external &&
    compiled.split.write.stage === ATOMIC_MUTATION
  ) {
    throw ExternalWriteRefusal(
      compiled.root.external,
      compiled.split.write.stage,
    );
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
 * would hide the root a write target is built from.
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
 * re-used for the whole iteration.
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

/** A query is a feed exactly when it ends in `changes`; anywhere else the fold still refuses it. */
function IsFeed(stages: QueryStage[]): boolean {
  return stages[stages.length - 1]?.stage === CHANGES_STAGE;
}

/**
 * Answers one element of whichever kind of iteration `reqId` names.
 *
 * `ReadCursor` is the contract's one entry point for both, and `reqId` comes from the same
 * module-global counter either way, so the kind is decided from the *stages* — and a `reqId`
 * belongs to one kind for the whole of its life, which is what {@link CloseCursor} relies on.
 *
 * A `changes` stage anywhere but last is deliberately **not** handled here: it is a pipeline stage,
 * so the fold declines it with `REJECTED_STAGES`' permanent message unaided, and awaiting a feed
 * rather than iterating it reaches `RunQuery`, which refuses it the same way.
 */
export function ReadCursor(
  reqId: number,
  stages: QueryStage[],
): Promise<IteratorResult<any, void>> {
  try {
    if (IsFeed(stages) || IsRegisteredFeed(reqId)) {
      return ReadFeedEvent(reqId, stages);
    }
    return ReadCursorRow(reqId, () => CompileCursor(stages, QueryContext()));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Closes whichever kind `reqId` named, and is total for a `reqId` that never opened.
 *
 * The consumer calls this unconditionally — `IterableCursor.return()` does, for a cursor that was
 * built and never iterated — so it cannot ask the caller which kind it is closing. A feed the
 * registry already knows goes straight to it.
 *
 * **An id neither registry has seen is closed in both**, because at that point nothing can say
 * which kind it was going to be: the stages arrive with the first *read*, and a close can precede
 * one. Ending only the cursor left the next read free to open a live feed the close was meant to
 * prevent — measured. Both closes are total for an unknown id and both bound what they remember.
 */
export function CloseCursor(reqId: number): Promise<void> {
  if (IsRegisteredFeed(reqId)) {
    return CloseOneFeed(reqId);
  }
  return CloseOneCursor(reqId).then(() => CloseOneFeed(reqId));
}
