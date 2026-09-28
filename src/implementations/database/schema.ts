import assert from "node:assert";
import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { ServesCrossInstance } from "./ddl";
import { BuildIndexes, ConvergeTables } from "./migrate";
import { ParseSchema, type SchemaShape, type TableShape } from "./fields";

/** Told the name a `CROSS_INSTANCE` read scans a table by. */
export type CrossInstanceScanNotice = (indexId: string) => void;

type TableScanNotices = Record<string, CrossInstanceScanNotice>;

const definitions: Record<string, SchemaDefinition> = {};
const shapes: Record<string, SchemaShape> = {};
const scanNotices: Record<string, TableScanNotices> = {};
const ready: Record<string, Promise<void>> = {};
const indexing: Record<string, Promise<void>> = {};

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
  shape: TableShape,
): Set<string> {
  const indexes = Object.entries(table.indexes ?? {});
  const unserved = indexes.filter(
    ([indexId, index]) => !ServesCrossInstance(indexId, index, shape),
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
  shape: SchemaShape,
): TableScanNotices {
  const notices: TableScanNotices = {};
  for (const [tableId, table] of Object.entries(schema)) {
    const unserved = UnservedIndexes(table, shape[tableId]);
    notices[tableId] = ScanNotice(schemaId, tableId, unserved);
  }
  return notices;
}

/**
 * Parses the schema and converges its tables; the secondary indexes then converge in the
 * background, tracked in `indexing`, so the readiness gate never waits on an index build.
 */
async function initialize(schemaId: string, schema: SchemaDefinition) {
  const shape = ParseSchema(schemaId, schema);
  shapes[schemaId] = shape;
  scanNotices[schemaId] = SchemaScanNotices(schemaId, schema, shape);
  const plans = await ConvergeTables(schemaId, schema, shape);
  indexing[schemaId] = BuildIndexes(schemaId, plans);
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
 * unconditionally there wipes the live schema and leaves the worst of both: `ready[schemaId]` is
 * the second registration's *resolved* promise, so every subsequent query passes
 * {@link WaitForSchemaReady} and then dies in {@link GetTableShape} with `Unknown schema` — for a
 * schema that is registered, converged, and whose tables exist. Comparing the gate against this
 * call's own promise is the same ownership test `migrate.ts:EnsureRegistry` already makes.
 */
export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition) {
    definitions[schemaId] = schema;
    const pending: Promise<void> = initialize(schemaId, schema).catch((err) => {
      if (ready[schemaId] === pending) {
        delete definitions[schemaId];
        delete shapes[schemaId];
        delete scanNotices[schemaId];
      }
      throw err;
    });
    ready[schemaId] = pending;
    pending.catch(() => {});
    return pending;
  },
  unregister(schemaId: string) {
    delete definitions[schemaId];
    delete shapes[schemaId];
    delete scanNotices[schemaId];
    delete ready[schemaId];
    delete indexing[schemaId];
  },
};

function MissingSchema(schemaId: string): string {
  return `Unknown schema '${schemaId}'`;
}

function MissingTable(schemaId: string, tableId: string): string {
  return `Unknown table '${schemaId}.${tableId}'`;
}

export function WaitForSchemaReady(schemaId: string): Promise<void> {
  return Object.hasOwn(ready, schemaId) ? ready[schemaId] : Promise.resolve();
}

export function GetSchema(schemaId: string): SchemaDefinition {
  assert(Object.hasOwn(definitions, schemaId), MissingSchema(schemaId));
  return definitions[schemaId];
}

export function GetTable(schemaId: string, tableId: string): TableDefinition {
  const schema = GetSchema(schemaId);
  assert(Object.hasOwn(schema, tableId), MissingTable(schemaId, tableId));
  return schema[tableId];
}

export function GetTableShape(schemaId: string, tableId: string): TableShape {
  assert(Object.hasOwn(shapes, schemaId), MissingSchema(schemaId));
  const shape = shapes[schemaId];
  assert(Object.hasOwn(shape, tableId), MissingTable(schemaId, tableId));
  return shape[tableId];
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
  assert(Object.hasOwn(scanNotices, schemaId), MissingSchema(schemaId));
  const notices = scanNotices[schemaId];
  assert(Object.hasOwn(notices, tableId), MissingTable(schemaId, tableId));
  return notices[tableId];
}

/**
 * Settles once the schema is ready and its background index phase has settled, whatever the
 * phase's outcome. Nothing in the query path awaits it; it is how a caller observes the phase.
 */
export async function WaitForIndexes(schemaId: string): Promise<void> {
  await WaitForSchemaReady(schemaId);
  if (Object.hasOwn(indexing, schemaId)) {
    await indexing[schemaId];
  }
}
