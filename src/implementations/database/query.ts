import assert from "node:assert";
import { CreateInstance, DestroyInstance, ListInstances } from "./instances";
import { GetTableNames, WaitForSchemaReady } from "./schema";
import { CREATE_INSTANCE, DESTROY_INSTANCE, type QueryStage } from "./utils";

type LifecycleHandler = (
  schemaId: string,
  stage: QueryStage,
) => Promise<unknown>;

const UNIMPLEMENTED =
  "The PostgreSQL backend does not execute queries yet (scaffold only)";
const MISSING_SCHEMA_ID = "Lifecycle query is missing its schema id";

const ROOT_STAGE = "schema";
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
    stages[0].stage !== ROOT_STAGE
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

export async function RunQuery(stages: QueryStage[]): Promise<any> {
  const lifecycle = Lifecycle(stages);
  if (lifecycle) {
    return lifecycle;
  }
  throw new Error(UNIMPLEMENTED);
}

export async function ReadCursor(
  _reqId: number,
  _stages: QueryStage[],
): Promise<IteratorResult<any, void>> {
  throw new Error(UNIMPLEMENTED);
}

export async function CloseCursor(_reqId: number): Promise<void> {}
