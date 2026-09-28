import { DatabaseError, type Pool, type PoolClient } from "pg";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { ReadTable } from "./introspect";
import { SchemaName } from "./identifier";
import { REGISTRY_SCHEMA } from "./utils";
import type { SchemaShape } from "./fields";
import { REGISTRY_STATEMENTS } from "./instances";
import { GetOptions, type MigrationMode } from "../../config";
import { CHANGE_LOG_STATEMENTS, TriggerStatements } from "./changes";
import {
  AcquireClient,
  GetPool,
  Query,
  RegisterBeforeDisconnect,
} from "../../connection";
import {
  BuildSchemaPlan,
  CreateSchemaSql,
  PlanIndexStatements,
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

const TABLES_LOCK_NAMESPACE = "antelopejs:converge:tables:";
const INDEXES_LOCK_NAMESPACE = "antelopejs:converge:indexes:";
const TABLES_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
const TRY_INDEXES_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked";
const INDEXES_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";
const CANCEL_BACKEND_SQL = "SELECT pg_cancel_backend($1)";
const BACKEND_PID_SQL = "SELECT pg_backend_pid() AS pid";
const UNLIMITED_SESSION_STATEMENT_TIMEOUT = "SET statement_timeout = 0";
const RESTORE_SESSION_STATEMENT_TIMEOUT = "RESET statement_timeout";

interface LockRow {
  locked: boolean;
}

interface PidRow {
  pid: number;
}

/** A background index phase: the client holding its lock, its backend, and whether to stop. */
interface IndexBuild {
  readonly client: PoolClient;
  pid: number;
  isStopping: boolean;
}

/** What converging a schema's tables changes, and what it declined to change. */
interface SchemaChanges {
  statements: string[];
  warnings: string[];
}

const INDEX_BUILD_STOPPED = new Error(
  "PostgreSQL index build stopped: the adapter is disconnecting",
);

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
const indexBuilds = new Set<IndexBuild>();
const indexPhases = new Set<Promise<void>>();

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

async function Rollback(client: PoolClient): Promise<boolean> {
  try {
    await client.query(ROLLBACK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs work as one transaction on one client, held for its duration.
 * Nothing in between may touch the pool, and a client whose `ROLLBACK` missed is destroyed.
 */
async function InTransaction(
  schemaName: string,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await AcquireClient();
  try {
    await RunEach(client, schemaName, TRANSACTION_PROLOGUE);
    await work(client);
    await RunEach(client, schemaName, [COMMIT]);
  } catch (err) {
    const rolledBack = await Rollback(client);
    client.release(rolledBack ? undefined : ABORTED_TRANSACTION);
    throw err;
  }
  client.release();
}

async function Apply(
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  if (statements.length === 0) {
    return;
  }
  await InTransaction(schemaName, (client) =>
    RunEach(client, schemaName, statements),
  );
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
): Promise<SchemaChanges> {
  const merged: SchemaChanges = {
    statements: SeedStatements(schemaName),
    warnings: [],
  };
  for (const plan of plans) {
    const actual = await ReadTable(client, schemaName, plan.table);
    const table = PlanTable(schemaName, plan, actual, mode);
    merged.statements.push(...table.statements);
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

function ReportIndexBuilds(schemaName: string, applied: number): void {
  if (applied <= NOTHING_TO_CONVERGE) {
    return;
  }
  Logger.Info(
    `converged the indexes of schema '${schemaName}' in ${applied} statements`,
  );
}

function LockKey(namespace: string, schemaName: string): string[] {
  return [`${namespace}${schemaName}`];
}

/** Plans and applies the schema, its tables and columns, holding the schema's tables lock. */
function ConvergeTablesLocked(
  schemaName: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const baseline = SeedStatements(schemaName).length;
  return InTransaction(schemaName, async (client) => {
    await client.query(
      TABLES_LOCK_SQL,
      LockKey(TABLES_LOCK_NAMESPACE, schemaName),
    );
    const mode = GetOptions().migrations;
    const changes = await PlanSchema(client, schemaName, plans, mode);
    await RunEach(client, schemaName, changes.statements);
    ReportConvergence(schemaName, changes.statements.length - baseline);
    WarnOnce(changes.warnings);
  });
}

/**
 * Brings a registered schema's PostgreSQL schema, tables and columns in line with its definition,
 * and answers the table plans {@link BuildIndexes} converges the secondary indexes from.
 *
 * The desired plan is a pure function of the definition, so it is built once up front and the
 * retried region is introspect, diff and apply — only the catalog state can go stale between
 * attempts.
 *
 * Processes converging the same schema take turns through a transaction-scoped advisory lock per
 * schema, awaited with `pg_advisory_xact_lock`, and the one that goes second re-reads the catalog
 * and finds nothing left to do. Blocking on it is safe because its holder never builds an index
 * concurrently, and the lock ends with the transaction, so a process that dies mid-way releases it.
 *
 * A duplicate-object failure means something outside that lock — a process on an older version of
 * this adapter — created an object between the introspection and the DDL, which makes the diff
 * stale rather than the statements retryable, so the whole convergence is what gets attempted
 * again.
 */
export async function ConvergeTables(
  schemaId: string,
  schema: SchemaDefinition,
  shape: SchemaShape,
): Promise<TablePlan[]> {
  const schemaName = SchemaName(schemaId);
  const plans = BuildSchemaPlan(schema, shape);
  await EnsureRegistry();
  await RetryOnDuplicateObject(() => ConvergeTablesLocked(schemaName, plans));
  return plans;
}

async function PlanIndexPhase(
  client: PoolClient,
  schemaName: string,
  plans: readonly TablePlan[],
): Promise<string[]> {
  const statements: string[] = [];
  for (const plan of plans) {
    const actual = await ReadTable(client, schemaName, plan.table);
    statements.push(...PlanIndexStatements(schemaName, plan, actual));
  }
  return statements;
}

/** Runs the index statements one by one, stopping between two when shutdown asked it to. */
async function RunIndexStatements(
  build: IndexBuild,
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    if (build.isStopping) {
      throw INDEX_BUILD_STOPPED;
    }
    await RunEach(build.client, schemaName, [statement]);
  }
}

async function TryIndexesLock(
  client: PoolClient,
  key: readonly string[],
): Promise<boolean> {
  const result = await client.query<LockRow>(TRY_INDEXES_LOCK_SQL, [...key]);
  return result.rows[0].locked;
}

/** Converges the indexes under the schema's indexes lock, or does nothing when another holds it. */
async function BuildIndexesLocked(
  build: IndexBuild,
  schemaName: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const { client } = build;
  const key = LockKey(INDEXES_LOCK_NAMESPACE, schemaName);
  await client.query(UNLIMITED_SESSION_STATEMENT_TIMEOUT);
  if (await TryIndexesLock(client, key)) {
    const statements = await PlanIndexPhase(client, schemaName, plans);
    await RunIndexStatements(build, schemaName, statements);
    await client.query(INDEXES_UNLOCK_SQL, key);
    ReportIndexBuilds(schemaName, statements.length);
  }
  await client.query(RESTORE_SESSION_STATEMENT_TIMEOUT);
}

function AsError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(Describe(cause));
}

async function BackendPid(client: PoolClient): Promise<number> {
  const result = await client.query<PidRow>(BACKEND_PID_SQL);
  return result.rows[0].pid;
}

/**
 * Runs the index phase on a client of its own; a failure destroys the client, which releases the
 * session lock with it. A build shutdown stopped settles quietly, and is repaired by the next one.
 */
async function RunIndexPhase(
  schemaName: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const client = await AcquireClient();
  const build: IndexBuild = { client, pid: 0, isStopping: false };
  indexBuilds.add(build);
  try {
    build.pid = await BackendPid(client);
    await BuildIndexesLocked(build, schemaName, plans);
  } catch (err) {
    client.release(AsError(err));
    if (build.isStopping) {
      return;
    }
    throw err;
  } finally {
    indexBuilds.delete(build);
  }
  client.release();
}

function ReportIndexFailure(schemaName: string, err: unknown): void {
  Logger.Error(
    `Building the indexes of schema '${schemaName}' failed; the next registration retries it`,
    err,
  );
}

/**
 * Converges a schema's secondary indexes, once {@link ConvergeTables} has converged its tables.
 *
 * Meant to run in the background: queries never wait for it, and their results never depend on
 * whether an index exists yet. The answer never rejects — a failure is logged, and whatever it left
 * behind is repaired by the next registration.
 *
 * Every index is built with `CREATE INDEX CONCURRENTLY`, so writes keep flowing while it builds,
 * and an index a failed build left `INVALID` is dropped and built again. The phase is serialized
 * across processes by a session advisory lock per schema, taken with a single
 * `pg_try_advisory_lock`: when another process holds it, that process is already converging the
 * same indexes and this phase does nothing. It is never awaited, because a backend blocked in
 * `pg_advisory_lock` holds a snapshot the holder's `CREATE INDEX CONCURRENTLY` would wait out. The
 * lock is held on a dedicated client with no statement timeout, since a build lasts as long as the
 * table is large; that client is destroyed on failure and its backend cancelled on disconnect, so
 * neither leaves the lock held.
 */
export function BuildIndexes(
  schemaId: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const schemaName = SchemaName(schemaId);
  const phase = RunIndexPhase(schemaName, plans).catch((err: unknown) =>
    ReportIndexFailure(schemaName, err),
  );
  indexPhases.add(phase);
  void phase.finally(() => indexPhases.delete(phase));
  return phase;
}

/** Cancels every running index build and waits for each to hand its client back. */
async function StopIndexBuilds(): Promise<void> {
  const running = [...indexBuilds];
  for (const build of running) {
    build.isStopping = true;
  }
  await Promise.allSettled(
    running.map((build) => Query(CANCEL_BACKEND_SQL, [build.pid])),
  );
  await Promise.allSettled(indexPhases);
}

RegisterBeforeDisconnect(StopIndexBuilds);
