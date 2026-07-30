import assert from "node:assert";
import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";
import { ParseSchema, type SchemaShape, type TableShape } from "./fields";

const definitions: Record<string, SchemaDefinition> = {};
const shapes: Record<string, SchemaShape> = {};
const ready: Record<string, Promise<void>> = {};

async function initialize(schemaId: string, schema: SchemaDefinition) {
  shapes[schemaId] = ParseSchema(schemaId, schema);
}

/**
 * Implementation of the `Schemas` registering proxy.
 *
 * Registration is driven by a consumer's module import side effect and is not
 * awaited by the caller, so the resulting promise is tracked here and awaited by
 * the query path through {@link WaitForSchemaReady}. A failed registration keeps
 * its rejected promise so the gate rethrows the parse error rather than letting
 * the query path proceed against a schema that was never parsed.
 */
export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition) {
    definitions[schemaId] = schema;
    const pending = initialize(schemaId, schema).catch((err) => {
      delete definitions[schemaId];
      delete shapes[schemaId];
      throw err;
    });
    ready[schemaId] = pending;
    pending.catch(() => {});
    return pending;
  },
  unregister(schemaId: string) {
    delete definitions[schemaId];
    delete shapes[schemaId];
    delete ready[schemaId];
  },
};

export function WaitForSchemaReady(schemaId: string): Promise<void> {
  return ready[schemaId] ?? Promise.resolve();
}

export function GetSchema(schemaId: string): SchemaDefinition {
  assert(schemaId in definitions, `Unknown schema '${schemaId}'`);
  return definitions[schemaId];
}

export function GetTable(schemaId: string, tableId: string): TableDefinition {
  const schema = GetSchema(schemaId);
  assert(tableId in schema, `Unknown table '${schemaId}.${tableId}'`);
  return schema[tableId];
}

export function GetTableShape(schemaId: string, tableId: string): TableShape {
  const shape = shapes[schemaId];
  assert(shape, `Unknown schema '${schemaId}'`);
  const table = shape[tableId];
  assert(table, `Unknown table '${schemaId}.${tableId}'`);
  return table;
}

export function GetTableNames(schemaId: string): string[] {
  return Object.keys(GetSchema(schemaId));
}

/**
 * Resolves an index by name, falling back to treating the name as a bare field.
 *
 * The contract allows `getAll`/`between`/`orderBy` to name an undeclared field,
 * which must still resolve to a usable predicate.
 */
export function GetIndex(
  schemaId: string,
  tableId: string,
  indexId: string,
  onlyIndex?: boolean,
): IndexDefinition {
  const table = GetTable(schemaId, tableId);
  if (indexId in table.indexes) {
    return table.indexes[indexId];
  }
  assert(!onlyIndex, `Unknown index '${indexId}' on '${schemaId}.${tableId}'`);
  return { fields: [indexId] };
}
