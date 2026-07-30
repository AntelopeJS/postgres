import assert from "node:assert";
import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";
import { RESERVED_COLUMNS } from "./utils";

const definitions: Record<string, SchemaDefinition> = {};
const ready: Record<string, Promise<void>> = {};

function assertNoReservedFields(schemaId: string, schema: SchemaDefinition) {
  for (const [tableId, table] of Object.entries(schema)) {
    for (const field of Object.keys(table.fields ?? {})) {
      assert(
        !RESERVED_COLUMNS.includes(field),
        `Field '${field}' on '${schemaId}.${tableId}' uses a reserved column name (${RESERVED_COLUMNS.join(", ")})`,
      );
    }
  }
}

async function initialize(schemaId: string, schema: SchemaDefinition) {
  assertNoReservedFields(schemaId, schema);
}

/**
 * Implementation of the `Schemas` registering proxy.
 *
 * Registration is driven by a consumer's module import side effect and is not
 * awaited by the caller, so the resulting promise is tracked here and awaited by
 * the query path through {@link WaitForSchemaReady}.
 */
export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition) {
    definitions[schemaId] = schema;
    const pending = initialize(schemaId, schema).catch((err) => {
      delete definitions[schemaId];
      delete ready[schemaId];
      throw err;
    });
    ready[schemaId] = pending;
    return pending;
  },
  unregister(schemaId: string) {
    delete definitions[schemaId];
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
