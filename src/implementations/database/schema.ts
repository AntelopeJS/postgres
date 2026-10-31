import assert from "node:assert";
import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { IsExternal } from "../../config";
import { DescribeExternalSchema } from "./external-schema";
import { ServesCrossInstance } from "./ddl";
import { BuildIndexes, ConvergeTables } from "./migrate";
import { ParseSchema, type SchemaModel, type TableModel } from "./fields";

/** Told the name a `CROSS_INSTANCE` read scans a table by. */
export type CrossInstanceScanNotice = (indexId: string) => void;

type TableScanNotices = Record<string, CrossInstanceScanNotice>;

const definitions = new Map<string, SchemaDefinition>();
const schemaModels = new Map<string, SchemaModel>();
const scanNotices = new Map<string, TableScanNotices>();
const ready = new Map<string, Promise<void>>();
const indexing = new Map<string, Promise<void>>();
const guardedWrites = new Set<string>();

function UnservedScanWarning(
  schemaId: string,
  tableId: string,
  indexId: string,
): string {
  return `A CROSS_INSTANCE query on '${schemaId}.${tableId}' scans index '${indexId}', which is not declared crossInstance: its physical index leads with the instance, so the query stays correct but may be slow. Set crossInstance: true on the index to keep such queries fast`;
}

/** The declared indexes of a table no unprefixed physical index backs. */
function UnservedIndexes(
  table: TableDefinition,
  model: TableModel,
): Set<string> {
  const indexes = Object.entries(table.indexes ?? {});
  const unserved = indexes.filter(
    ([indexId, index]) => !ServesCrossInstance(indexId, index, model),
  );
  return new Set(unserved.map(([indexId]) => indexId));
}

/**
 * Warns, once per index per registration, that a `CROSS_INSTANCE` read scans a declared index no
 * unprefixed physical index backs. The set is computed once, so the read pays one lookup; a name
 * that is not a declared index is a plain field, and never warns.
 */
function ScanNotice(
  schemaId: string,
  tableId: string,
  unserved: Set<string>,
): CrossInstanceScanNotice {
  return (indexId) => {
    if (unserved.delete(indexId)) {
      Logger.Warn(UnservedScanWarning(schemaId, tableId, indexId));
    }
  };
}

function SchemaScanNotices(
  schemaId: string,
  schema: SchemaDefinition,
  model: SchemaModel,
) {
  const notices: TableScanNotices = {};
  for (const [tableId, table] of Object.entries(schema)) {
    const unserved = UnservedIndexes(table, model[tableId]);
    notices[tableId] = ScanNotice(schemaId, tableId, unserved);
  }
  return notices;
}

const NoScan: CrossInstanceScanNotice = () => {};

/** An external table has no instances to scan across, so nothing ever warns about one. */
function QuietNotices(schema: SchemaDefinition) {
  const notices: TableScanNotices = {};
  for (const tableId of Object.keys(schema)) {
    notices[tableId] = NoScan;
  }
  return notices;
}

/** Reads each parsed table's shape off the catalog instead of converging it. */
async function InitializeExternal(
  schemaId: string,
  schema: SchemaDefinition,
  parsed: SchemaModel,
) {
  schemaModels.set(
    schemaId,
    await DescribeExternalSchema(schemaId, schema, parsed),
  );
  scanNotices.set(schemaId, QuietNotices(schema));
}

/**
 * Parses the schema and converges its tables; the secondary indexes then converge in the
 * background, tracked in `indexing`, so the readiness gate never waits on an index build.
 */
async function initialize(schemaId: string, schema: SchemaDefinition) {
  const model = ParseSchema(schemaId, schema);
  if (IsExternal()) {
    await InitializeExternal(schemaId, schema, model);
    return;
  }
  schemaModels.set(schemaId, model);
  scanNotices.set(schemaId, SchemaScanNotices(schemaId, schema, model));
  const plans = await ConvergeTables(schemaId, schema, model);
  indexing.set(schemaId, BuildIndexes(schemaId, plans));
  guardedWrites.delete(schemaId);
  if (DeclaresUniqueIndex(schema)) {
    guardedWrites.add(schemaId);
  }
}

function DeclaresUniqueIndex(schema: SchemaDefinition): boolean {
  return Object.values(schema).some((table) =>
    Object.values(table.indexes ?? {}).some((index) => index.unique === true),
  );
}

/**
 * Implementation of the `Schemas` registering proxy.
 *
 * Registration is driven by a consumer's module import side effect and is not
 * awaited by the caller, so the resulting promise is tracked here and awaited by
 * the query path through {@link WaitForSchemaReady}. A failed registration keeps
 * its rejected promise so the gate rethrows that failure rather than letting the
 * query path proceed against a schema that was never parsed or converged.
 *
 * The definition is parsed before the database is touched, so a declaration the
 * parser rejects fails with its message without opening a connection.
 *
 * **A failed registration only rolls back state it still owns.** Registration is fire-and-forget
 * and re-registering an id is legal, so a slow failure can settle *after* a later registration of
 * the same id has already succeeded and installed its own definition, shape and gate. Deleting
 * unconditionally there wipes the live schema and leaves the worst of both: `ready.get(schemaId)` is
 * the second registration's *resolved* promise, so every subsequent query passes
 * {@link WaitForSchemaReady} and then dies in {@link GetTableModel} with `Unknown schema` — for a
 * schema that is registered, converged, and whose tables exist. Comparing the gate against this
 * call's own promise is the same ownership test `migrate.ts:EnsureRegistry` already makes.
 */
export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition) {
    definitions.set(schemaId, schema);
    const pending: Promise<void> = initialize(schemaId, schema).catch(
      (err: unknown) => {
        if (ready.get(schemaId) === pending) {
          definitions.delete(schemaId);
          schemaModels.delete(schemaId);
          scanNotices.delete(schemaId);
          guardedWrites.delete(schemaId);
        }
        throw err;
      },
    );
    ready.set(schemaId, pending);
    pending.catch(() => {});
    return pending;
  },
  unregister(schemaId: string) {
    definitions.delete(schemaId);
    schemaModels.delete(schemaId);
    scanNotices.delete(schemaId);
    ready.delete(schemaId);
    indexing.delete(schemaId);
    guardedWrites.delete(schemaId);
  },
};

function MissingSchema(schemaId: string): string {
  return `Unknown schema '${schemaId}'`;
}

function MissingTable(schemaId: string, tableId: string): string {
  return `Unknown table '${schemaId}.${tableId}'`;
}

export function WaitForSchemaReady(schemaId: string): Promise<void> {
  return ready.get(schemaId) ?? Promise.resolve();
}

export function GetSchema(schemaId: string): SchemaDefinition {
  const schema = definitions.get(schemaId);
  assert(schema, MissingSchema(schemaId));
  return schema;
}

export function GetTable(schemaId: string, tableId: string): TableDefinition {
  const schema = GetSchema(schemaId);
  assert(Object.hasOwn(schema, tableId), MissingTable(schemaId, tableId));
  return schema[tableId];
}

export function GetTableModel(schemaId: string, tableId: string): TableModel {
  const model = schemaModels.get(schemaId);
  assert(model, MissingSchema(schemaId));
  assert(Object.hasOwn(model, tableId), MissingTable(schemaId, tableId));
  return model[tableId];
}

export function GetTableNames(schemaId: string): string[] {
  return Object.keys(GetSchema(schemaId));
}

/**
 * Resolves an index by name, falling back to treating the name as a bare field.
 *
 * The contract allows `getAll`/`between`/`orderBy` to name an undeclared field,
 * which must still resolve to a usable predicate.
 *
 * A definition that declares no indexes at all reads as an empty set rather than
 * as nothing, which is how `ddl.ts` already reads the same field: the contract
 * types it as required, so a caller omitting it is only reachable from
 * JavaScript — and it then fails here with a message naming neither the schema
 * nor the index, on a table the DDL converged happily.
 */
export function GetIndex(
  schemaId: string,
  tableId: string,
  indexId: string,
  onlyIndex?: boolean,
): IndexDefinition {
  const indexes = GetTable(schemaId, tableId).indexes ?? {};
  if (Object.hasOwn(indexes, indexId)) {
    return indexes[indexId];
  }
  assert(!onlyIndex, `Unknown index '${indexId}' on '${schemaId}.${tableId}'`);
  return { fields: [indexId] };
}

/** The notice a table's `CROSS_INSTANCE` scans report to, built once at registration. */
export function GetCrossInstanceScanNotice(
  schemaId: string,
  tableId: string,
): CrossInstanceScanNotice {
  const notices = scanNotices.get(schemaId);
  assert(notices, MissingSchema(schemaId));
  assert(Object.hasOwn(notices, tableId), MissingTable(schemaId, tableId));
  return notices[tableId];
}

/**
 * Settles once the schema is ready and its background index phase has settled, whatever the
 * phase's outcome. Nothing in the query path awaits it; it is how a caller observes the phase.
 */
export async function WaitForIndexes(schemaId: string): Promise<void> {
  await WaitForSchemaReady(schemaId);
  await indexing.get(schemaId);
}

/**
 * Settles once a write to the schema can rely on its unique indexes, which is when its background
 * index phase has settled — immediately for a schema that declares none.
 *
 * Reads never wait for the index phase, since an index only changes how fast they run. A unique
 * index changes what a write is allowed to store, so a write that ran before it is built could
 * store the duplicate it exists to refuse; writes to such a schema wait instead, and only for the
 * one phase each registration starts.
 */
export async function WaitForUniqueIndexes(schemaId: string): Promise<void> {
  if (guardedWrites.has(schemaId)) {
    await WaitForIndexes(schemaId);
  }
}
