import assert from "node:assert";
import { Query } from "../../connection";
import { DecodingContext } from "./context";
import { CompileExpression } from "./expression";
import { CreateInstance, DestroyInstance, ListInstances } from "./instances";
import { ApplyStages } from "./pipeline";
import {
  OUTPUT_COLUMN,
  type Relation,
  Render,
  RequireOrigin,
} from "./relation";
import { DecodeRow, ReviveValue } from "./result";
import { GetTableNames, WaitForSchemaReady } from "./schema";
import { BuildRoot, CollectSchemaIds, SCHEMA_STAGE } from "./selection";
import type { Compiled } from "./sql";
import { CREATE_INSTANCE, DESTROY_INSTANCE, type QueryStage } from "./utils";

type LifecycleHandler = (
  schemaId: string,
  stage: QueryStage,
) => Promise<unknown>;

export type ResultRow = Record<string, unknown>;

const UNIMPLEMENTED =
  "The PostgreSQL backend does not implement cursors yet (scaffold only)";
const SUBQUERY_UNIMPLEMENTED =
  "The PostgreSQL backend does not implement correlated subqueries yet";
const MISSING_SCHEMA_ID = "Lifecycle query is missing its schema id";

const LIFECYCLE_STAGE_COUNT = 2;

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

function CompileSubquery(): Compiled {
  throw new Error(SUBQUERY_UNIMPLEMENTED);
}

function DecodeRows(relation: Relation, rows: ResultRow[]): unknown[] {
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
 * Dispatches on the same `projection` discriminator the select list was built from, so the two
 * output modes cannot drift apart, and honours the relation's own answer to whether it yields
 * exactly one row: a single-row relation hands back that row rather than a one-element array,
 * and `null` — never `undefined` — when the read found nothing, which is what `nth` past the end
 * reaches the caller as.
 */
export function DecodeResult(relation: Relation, rows: ResultRow[]): unknown {
  const decoded = DecodeRows(relation, rows);
  return relation.single ? (decoded[0] ?? null) : decoded;
}

export async function RunQuery(stages: QueryStage[]): Promise<any> {
  const lifecycle = Lifecycle(stages);
  if (lifecycle) {
    return lifecycle;
  }
  await Promise.all(CollectSchemaIds(stages).map(WaitForSchemaReady));
  const context = new DecodingContext(CompileExpression, CompileSubquery);
  const root = BuildRoot(stages, context);
  const relation = ApplyStages(root.relation, root.rest, context);
  const result = await Query<ResultRow>(Render(relation), context.params.all());
  return DecodeResult(relation, result.rows);
}

export async function ReadCursor(
  _reqId: number,
  _stages: QueryStage[],
): Promise<IteratorResult<any, void>> {
  throw new Error(UNIMPLEMENTED);
}

export async function CloseCursor(_reqId: number): Promise<void> {}
