import { Query } from "../../connection";
import { CreateSchemaSql } from "./ddl";
import { QualifiedName, SchemaName, TableReference } from "./identifier";
import { QuoteIdentifier } from "./sql";
import {
  CREATE_INSTANCE,
  DEFAULT_INSTANCE_ID,
  DESTROY_INSTANCE,
  INSTANCE_COLUMN,
  NormalizeInstanceId,
  REGISTRY_INSTANCES_TABLE,
  REGISTRY_SCHEMA,
} from "./utils";

interface InstanceRow {
  id: string;
}

const REGISTRY = QualifiedName(REGISTRY_SCHEMA, REGISTRY_INSTANCES_TABLE);
const SCHEMA_KEY = QuoteIdentifier("schema_id");
const INSTANCE_KEY = QuoteIdentifier("instance_id");
const CREATED_KEY = QuoteIdentifier("created_at");
const INSTANCE = QuoteIdentifier(INSTANCE_COLUMN);
const REGISTRY_KEY = `(${SCHEMA_KEY}, ${INSTANCE_KEY})`;
const INSTANCE_PARAM = "$1";
const SCHEMA_PARAM = "$2";
const PURGE_ALIAS_PREFIX = "purge_";

/**
 * DDL for the registry every schema's named instances are recorded in.
 *
 * Exported for the migrator's bootstrap, which is the only thing that applies
 * it; the shape lives here because every read and write of these rows does.
 *
 * Rows are keyed on the *physical* schema name rather than the registered
 * schema id: the registry itself is unprefixed and shared, so two deployments
 * on one database with different `schemaPrefix` values would otherwise see and
 * destroy each other's instances.
 */
export const REGISTRY_STATEMENTS: readonly string[] = [
  CreateSchemaSql(REGISTRY_SCHEMA),
  `CREATE TABLE IF NOT EXISTS ${REGISTRY} (
     ${SCHEMA_KEY} text NOT NULL,
     ${INSTANCE_KEY} text NOT NULL,
     ${CREATED_KEY} timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY ${REGISTRY_KEY}
   )`,
];

/**
 * Records an instance of a schema and returns the id it was recorded under.
 *
 * Idempotent: creating an instance that already exists is a no-op rather than
 * a conflict, because the contract gives callers no way to ask whether one is
 * already there and they routinely create the same instance on every boot.
 */
export async function CreateInstance(
  schemaId: string,
  id: unknown,
): Promise<string> {
  const instanceId = NormalizeInstanceId(CREATE_INSTANCE, id);
  await Query(
    `INSERT INTO ${REGISTRY} (${SCHEMA_KEY}, ${INSTANCE_KEY}) VALUES (${SCHEMA_PARAM}, ${INSTANCE_PARAM}) ON CONFLICT ${REGISTRY_KEY} DO NOTHING`,
    [instanceId, SchemaName(schemaId)],
  );
  return instanceId;
}

function PurgeBranches(
  schemaId: string,
  tableIds: readonly string[],
): string[] {
  return tableIds.map(
    (tableId, position) =>
      `${PURGE_ALIAS_PREFIX}${position} AS (DELETE FROM ${TableReference(schemaId, tableId)} WHERE ${INSTANCE} = ${INSTANCE_PARAM})`,
  );
}

function DestroyInstanceSql(
  schemaId: string,
  tableIds: readonly string[],
): string {
  const forget = `DELETE FROM ${REGISTRY} WHERE ${SCHEMA_KEY} = ${SCHEMA_PARAM} AND ${INSTANCE_KEY} = ${INSTANCE_PARAM}`;
  const branches = PurgeBranches(schemaId, tableIds);
  if (branches.length === 0) {
    return forget;
  }
  return `WITH ${branches.join(", ")} ${forget}`;
}

/**
 * Deletes an instance's rows from each of the schema's tables, then forgets it.
 *
 * An instance is a discriminator column rather than a namespace, so nothing
 * here drops a PostgreSQL schema or table: the same tables still hold every
 * other instance's rows.
 *
 * The whole destruction is one data-modifying CTE, so it is atomic without a
 * transaction and costs one round trip: a partial destroy would otherwise leave
 * rows behind that a later `createInstance` of the same id silently adopts.
 * PostgreSQL runs every data-modifying branch of a `WITH` exactly once whether
 * or not the main statement references it, which is why the branches need no
 * reference.
 *
 * @param tableIds The schema's tables, passed in rather than read back from
 * `schema.ts`: once `initialize` calls `SyncSchema`, importing it here closes
 * the cycle `schema → migrate → instances → schema`.
 */
export async function DestroyInstance(
  schemaId: string,
  tableIds: readonly string[],
  id: unknown,
): Promise<void> {
  const instanceId = NormalizeInstanceId(DESTROY_INSTANCE, id);
  await Query(DestroyInstanceSql(schemaId, tableIds), [
    instanceId,
    SchemaName(schemaId),
  ]);
}

/** Lists the schema's named instances; the default instance is not one. */
export async function ListInstances(schemaId: string): Promise<string[]> {
  const result = await Query<InstanceRow>(
    `SELECT ${INSTANCE_KEY} AS id FROM ${REGISTRY} WHERE ${SCHEMA_KEY} = ${SCHEMA_PARAM} AND ${INSTANCE_KEY} <> ${INSTANCE_PARAM} ORDER BY ${INSTANCE_KEY}`,
    [DEFAULT_INSTANCE_ID, SchemaName(schemaId)],
  );
  return result.rows.map((row) => row.id);
}
