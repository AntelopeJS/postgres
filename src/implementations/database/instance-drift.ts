import type { Querier } from "../../connection";
import {
  type InstanceCheck,
  type InstanceTarget,
  OpenInstance,
} from "../../instance-databases";
import type { InstanceRoute } from "./context";
import { type CatalogRelation, ReadRelation } from "./external-catalog";
import type { ExternalRelation, TableModel } from "./fields";
import { QualifiedName } from "./identifier";
import { GetTableModel, GetTableNames } from "./schema";

/** How long a database found different stays refused before its catalog is read again. */
const DRIFT_RETRY_MS = 30_000;

function KeyList(columns: readonly string[] | undefined): string {
  return columns ? `(${columns.join(", ")})` : "no key";
}

function ColumnDrifts(
  name: string,
  model: TableModel,
  relation: CatalogRelation,
): string[] {
  const columns = new Map(
    relation.columns.map((column) => [column.name, column]),
  );
  const drifts: string[] = [];
  for (const spec of Object.values(model.fields)) {
    const registered = spec.native;
    if (!registered) {
      continue;
    }
    const column = columns.get(registered.column);
    if (!column) {
      drifts.push(`${name} has no column "${registered.column}"`);
    } else if (column.native !== registered.native) {
      drifts.push(
        `${name}."${registered.column}" is ${column.native}, where ${registered.native} was registered`,
      );
    }
  }
  return drifts;
}

function KeyDrifts(
  name: string,
  external: ExternalRelation,
  relation: CatalogRelation,
): string[] {
  const registered = KeyList(external.key?.map((column) => column.column));
  const found = KeyList(relation.key);
  return registered === found
    ? []
    : [`${name} is keyed by ${found}, where ${registered} was registered`];
}

/** What one registered relation lacks or holds differently in the database `query` reads. */
async function RelationDrifts(
  model: TableModel,
  external: ExternalRelation,
  query: Querier,
): Promise<string[]> {
  const name = QualifiedName(external.schema, external.table);
  const relation = await ReadRelation(external.schema, external.table, query);
  if (!relation) {
    return [`${name} does not exist`];
  }
  if (!relation.readable) {
    return [`${name} cannot be read by the connected role`];
  }
  return [
    ...ColumnDrifts(name, model, relation),
    ...KeyDrifts(name, external, relation),
  ];
}

/**
 * Refuses an instance database that does not hold a schema as it was registered.
 *
 * Registration read the catalog of the database of `url` and compiled every statement from it. An
 * instance database is expected to be the same, and this is where that is checked: each declared
 * relation is looked up again there, and a missing relation, a missing column, another native type
 * or another key is named. Extra columns and relations are nobody's concern.
 */
async function Compare(target: InstanceTarget, schemaId: string) {
  const query: Querier = (sql, params) => target.pool.query(sql, params);
  const drifts: string[] = [];
  for (const tableId of GetTableNames(schemaId)) {
    const model = GetTableModel(schemaId, tableId);
    if (model.external) {
      drifts.push(...(await RelationDrifts(model, model.external, query)));
    }
  }
  if (drifts.length > 0) {
    throw new Error(
      `Instance '${target.instance}' reads database "${target.database}", which does not hold schema '${schemaId}' as it was registered: ${drifts.join("; ")}`,
    );
  }
}

function IsCurrent(check: InstanceCheck): boolean {
  return (
    check.failedAt === undefined || Date.now() - check.failedAt < DRIFT_RETRY_MS
  );
}

/** One comparison per schema and pool, shared by every statement that arrives while it runs. */
function CheckOf(target: InstanceTarget, schemaId: string): Promise<void> {
  const known = target.checks.get(schemaId);
  if (known && IsCurrent(known)) {
    return known.result;
  }
  const check: InstanceCheck = { result: Compare(target, schemaId) };
  check.result.catch(() => {
    check.failedAt = Date.now();
  });
  target.checks.set(schemaId, check);
  return check.result;
}

/**
 * Settles once the instance database a statement is routed to holds every schema it reads.
 *
 * A database is verified on its first statement and trusted for as long as its pool stays open; one
 * found different is refused, and looked at again after {@link DRIFT_RETRY_MS} so a migration that
 * caught up is noticed without a restart. Only that instance is refused.
 */
export async function VerifyInstance(route: InstanceRoute): Promise<void> {
  if (route.instance === undefined) {
    return;
  }
  const target = await OpenInstance(route.instance);
  await Promise.all(
    [...route.schemaIds].map((schemaId) => CheckOf(target, schemaId)),
  );
}
