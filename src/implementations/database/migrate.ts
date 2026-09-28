import { setTimeout as delay } from "node:timers/promises";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { ReadTable } from "./introspect";
import { SchemaName } from "./identifier";
import { REGISTRY_SCHEMA } from "./utils";
import type { SchemaShape } from "./fields";
import { REGISTRY_STATEMENTS } from "./instances";
import { AcquireClient, GetPool } from "../../connection";
import { GetOptions, type MigrationMode } from "../../config";
import { CHANGE_LOG_STATEMENTS, TriggerStatements } from "./changes";
import {
  BuildSchemaPlan,
  type ConvergencePlan,
  CreateSchemaSql,
  PlanTable,
  type TablePlan,
} from "./ddl";

const DUPLICATE_OBJECT_CODES = new Set(["23505", "42P06", "42P07", "42710"]);
const CONVERGENCE_RETRIES = 2;

const BEGIN = "BEGIN";
const COMMIT = "COMMIT";
const ROLLBACK = "ROLLBACK";
const UNLIMITED_STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = 0";
const TRANSACTION_PROLOGUE = [BEGIN, UNLIMITED_STATEMENT_TIMEOUT];

const SCHEMA_LOCK_NAMESPACE = "antelopejs:converge:";
const TRY_SCHEMA_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked";
const SCHEMA_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";
const SCHEMA_LOCK_POLL_MS = 100;
const UNLIMITED_SESSION_STATEMENT_TIMEOUT = "SET statement_timeout = 0";
const RESTORE_SESSION_STATEMENT_TIMEOUT = "RESET statement_timeout";

interface LockRow {
  locked: boolean;
}

const ABORTED_TRANSACTION = new Error(
  "PostgreSQL client discarded: its migration transaction could not be rolled back",
);

/**
 * Everything `__antelope` holds, applied as one transaction the first time a pool needs any of it.
 * The registry and the change log share one memoized bootstrap rather than each carrying its own.
 */
const BOOTSTRAP_STATEMENTS: readonly string[] = [
  ...REGISTRY_STATEMENTS,
  ...CHANGE_LOG_STATEMENTS,
];

/** Joins a schema and a table into one memo key, taking a character neither caller-supplied half can hold. */
const MEMO_SEPARATOR = "\u0000";

const NOTHING_TO_CONVERGE = 0;

const warned = new Set<string>();
let registryReady: Promise<void> | undefined;
let registryFor: Pool | undefined;
const triggersReady = new Map<string, Promise<void>>();

function IsDuplicateObject(err: unknown): boolean {
  if (err instanceof DatabaseError) {
    return err.code !== undefined && DUPLICATE_OBJECT_CODES.has(err.code);
  }
  return err instanceof Error && IsDuplicateObject(err.cause);
}

/**
 * Runs a convergence again when the catalog beat it to an object it creates, with no backoff.
 * `23505` is in the set, so the region admits DML only where a replay cannot swallow a violation.
 */
async function RetryOnDuplicateObject<T>(work: () => Promise<T>): Promise<T> {
  for (let remaining = CONVERGENCE_RETRIES; remaining > 0; remaining--) {
    try {
      return await work();
    } catch (err) {
      if (!IsDuplicateObject(err)) {
        throw err;
      }
    }
  }
  return work();
}

function Describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function MigrationError(
  schemaName: string,
  statement: string,
  cause: unknown,
): Error {
  return new Error(
    `Migrating schema '${schemaName}' failed on statement: ${statement} — ${Describe(cause)}`,
    { cause },
  );
}

/** Runs each statement on its own, in order, naming the one that failed. */
async function RunEach(
  client: PoolClient,
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (err) {
      throw MigrationError(schemaName, statement, err);
    }
  }
}

function RunTransaction(
  client: PoolClient,
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  const sequence = [...TRANSACTION_PROLOGUE, ...statements, COMMIT];
  return RunEach(client, schemaName, sequence);
}

async function Rollback(client: PoolClient): Promise<boolean> {
  try {
    await client.query(ROLLBACK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the statements as one transaction on one client, held for its duration.
 * Nothing in between may touch the pool, and a client whose `ROLLBACK` missed is destroyed.
 */
async function Apply(
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  if (statements.length === 0) {
    return;
  }
  const client = await AcquireClient();
  try {
    await RunTransaction(client, schemaName, statements);
  } catch (err) {
    const rolledBack = await Rollback(client);
    client.release(rolledBack ? undefined : ABORTED_TRANSACTION);
    throw err;
  }
  client.release();
}

function EnsureRegistry(): Promise<void> {
  const pool = GetPool();
  if (registryReady && registryFor === pool) {
    return registryReady;
  }
  triggersReady.clear();
  const pending: Promise<void> = RetryOnDuplicateObject(() =>
    Apply(REGISTRY_SCHEMA, BOOTSTRAP_STATEMENTS),
  ).catch((err) => {
    if (registryReady === pending) {
      registryReady = undefined;
      registryFor = undefined;
    }
    throw err;
  });
  registryReady = pending;
  registryFor = pool;
  return pending;
}

async function InstallTriggers(
  schemaId: string,
  tableId: string,
): Promise<void> {
  await EnsureRegistry();
  await Apply(SchemaName(schemaId), TriggerStatements(schemaId, tableId));
}

/**
 * Puts the change-log triggers on a table, once per process however many feeds ask for them.
 *
 * Installed the first time something watches a table rather than at convergence, because a trigger
 * installed at convergence taxes every write to every table forever whether or not anything ever
 * reads the log. They are never removed again: with two processes sharing a database, the one that
 * sees no local feed cannot know the other has one, so an unwatched-for-too-long drop would make
 * the other process's feed go deaf with no error on either side. Doing it safely needs a watcher
 * registry with heartbeats, which is its own piece of work — until then the cost of a table that
 * was watched once is one log row per write.
 *
 * Safe against a concurrent installer in **another** process without the bootstrap's
 * duplicate-object retry: `CREATE OR REPLACE TRIGGER` takes `ShareRowExclusiveLock`, so two
 * installers serialize and the loser's statement is a no-op rather than a `42710`. A trigger is one
 * object where a convergence is a whole plan, which is what makes the cheaper guard sufficient.
 *
 * **A failed install is not remembered.** The memo holds the promise, so a rejection removes its
 * own entry and the next feed on that table tries again — a table memoized as installed after a
 * failure would log nothing for the lifetime of the process, and its feeds would sit silent on a
 * table being written to.
 */
export function EnsureTriggers(
  schemaId: string,
  tableId: string,
): Promise<void> {
  const key = `${schemaId}${MEMO_SEPARATOR}${tableId}`;
  const known = triggersReady.get(key);
  if (known) {
    return known;
  }
  const pending = InstallTriggers(schemaId, tableId).catch((err: unknown) => {
    if (triggersReady.get(key) === pending) {
      triggersReady.delete(key);
    }
    throw err;
  });
  triggersReady.set(key, pending);
  return pending;
}

function WarnOnce(warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (warned.has(warning)) {
      continue;
    }
    warned.add(warning);
    Logger.Warn(warning);
  }
}

/** What a plan holds before any table is read: the baseline a convergence is measured against. */
function SeedStatements(schemaName: string): string[] {
  return [CreateSchemaSql(schemaName)];
}

async function PlanSchema(
  client: PoolClient,
  schemaName: string,
  plans: readonly TablePlan[],
  mode: MigrationMode,
): Promise<ConvergencePlan> {
  const merged: ConvergencePlan = {
    statements: SeedStatements(schemaName),
    indexStatements: [],
    warnings: [],
  };
  for (const plan of plans) {
    const actual = await ReadTable(client, schemaName, plan.table);
    const table = PlanTable(schemaName, plan, actual, mode);
    merged.statements.push(...table.statements);
    merged.indexStatements.push(...table.indexStatements);
    merged.warnings.push(...table.warnings);
  }
  return merged;
}

/**
 * Announces a convergence that changed something, counting only the DDL beyond the plan's own seed.
 * The seed is measured rather than assumed, so a second baseline statement cannot make every
 * steady-state registration announce itself.
 */
function ReportConvergence(schemaName: string, changed: number): void {
  if (changed <= NOTHING_TO_CONVERGE) {
    return;
  }
  Logger.Info(`converged schema '${schemaName}' in ${changed} statements`);
}

async function AcquireSchemaLock(
  client: PoolClient,
  key: readonly string[],
): Promise<void> {
  const tryLock = () => client.query<LockRow>(TRY_SCHEMA_LOCK_SQL, [...key]);
  while (!(await tryLock()).rows[0].locked) {
    await delay(SCHEMA_LOCK_POLL_MS);
  }
}

/** Runs work on one client holding the schema's lock; a failure destroys the client, releasing it. */
async function WithSchemaLock(
  schemaName: string,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const key = [`${SCHEMA_LOCK_NAMESPACE}${schemaName}`];
  const client = await AcquireClient();
  try {
    await client.query(UNLIMITED_SESSION_STATEMENT_TIMEOUT);
    await AcquireSchemaLock(client, key);
    await work(client);
    await client.query(SCHEMA_UNLOCK_SQL, key);
    await client.query(RESTORE_SESSION_STATEMENT_TIMEOUT);
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(Describe(err)));
    throw err;
  }
  client.release();
}

async function Converge(
  schemaName: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const baseline = SeedStatements(schemaName).length;
  await WithSchemaLock(schemaName, async (client) => {
    const mode = GetOptions().migrations;
    const merged = await PlanSchema(client, schemaName, plans, mode);
    await RunTransaction(client, schemaName, merged.statements);
    await RunEach(client, schemaName, merged.indexStatements);
    const applied = merged.statements.length + merged.indexStatements.length;
    ReportConvergence(schemaName, applied - baseline);
    WarnOnce(merged.warnings);
  });
}

/**
 * Brings a registered schema's PostgreSQL objects in line with its definition.
 *
 * The desired plan is a pure function of the definition, so it is built once
 * up front and the retried region is introspect, diff and apply — only the
 * catalog state can go stale between attempts.
 *
 * Processes converging the same schema take turns through a session advisory
 * lock per schema, and the one that goes second re-reads the catalog and finds
 * nothing left to do. The lock is polled with `pg_try_advisory_lock` rather
 * than awaited with `pg_advisory_lock`: a backend blocked in the latter holds a
 * snapshot, `CREATE INDEX CONCURRENTLY` waits out every older snapshot, and the
 * holder would wait on the very process waiting on it. It is held on one client
 * with no statement timeout, since an index build lasts as long as the table is
 * large, and a process that dies releases it by disconnecting.
 * Tables and columns converge in one transaction; indexes are then built with
 * `CREATE INDEX CONCURRENTLY`, so writes keep flowing while they build, and an
 * index a failed build left `INVALID` is dropped and built again.
 *
 * A duplicate-object failure means something outside that lock — a process on
 * an older version of this adapter — created an object between the
 * introspection and the DDL, which makes the diff stale rather than the
 * statements retryable, so the whole convergence is what gets attempted again.
 */
export async function SyncSchema(
  schemaId: string,
  schema: SchemaDefinition,
  shape: SchemaShape,
): Promise<void> {
  const schemaName = SchemaName(schemaId);
  const plans = BuildSchemaPlan(schema, shape);
  await EnsureRegistry();
  await RetryOnDuplicateObject(() => Converge(schemaName, plans));
}
