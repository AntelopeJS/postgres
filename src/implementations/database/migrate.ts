import type { SchemaDefinition } from "@antelopejs/interface-database/schema";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { GetOptions, type MigrationMode } from "../../config";
import { AcquireClient, GetPool } from "../../connection";
import { Logger } from "../../logger";
import {
  BuildSchemaPlan,
  type ConvergencePlan,
  CreateSchemaSql,
  PlanTable,
  type TablePlan,
} from "./ddl";
import type { SchemaShape } from "./fields";
import { SchemaName } from "./identifier";
import { REGISTRY_STATEMENTS } from "./instances";
import { ReadTable } from "./introspect";
import { REGISTRY_SCHEMA } from "./utils";

const DUPLICATE_OBJECT_CODES = new Set(["23505", "42P06", "42P07", "42710"]);
const CONVERGENCE_RETRIES = 2;

const BEGIN = "BEGIN";
const COMMIT = "COMMIT";
const ROLLBACK = "ROLLBACK";
const UNLIMITED_STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = 0";
const TRANSACTION_PROLOGUE = [BEGIN, UNLIMITED_STATEMENT_TIMEOUT];

const ABORTED_TRANSACTION = new Error(
  "PostgreSQL client discarded: its migration transaction could not be rolled back",
);

const warned = new Set<string>();
let registryReady: Promise<void> | undefined;
let registryFor: Pool | undefined;

function IsDuplicateObject(err: unknown): boolean {
  if (err instanceof DatabaseError) {
    return err.code !== undefined && DUPLICATE_OBJECT_CODES.has(err.code);
  }
  return err instanceof Error && IsDuplicateObject(err.cause);
}

/**
 * Runs a convergence again when the catalog beat it to an object it creates.
 *
 * There is deliberately no backoff. A duplicate-object failure means another
 * process won the race, so the loser's next attempt re-introspects, sees the
 * winner's object and plans a no-op — waiting first would only delay a
 * convergence that is already guaranteed rather than avoid a second collision.
 *
 * `23505` is in the set because two concurrent `CREATE … IF NOT EXISTS` surface
 * as a unique-key violation on a *catalog* index rather than as `42P06`/`42P07`.
 * That is a data-level code, so the retried region admits DML only where a
 * replay cannot swallow a genuine violation: a duplicate-row failure from an
 * `INSERT` must reach the caller rather than be retried into silence. The one
 * statement admitted under that rule is `ddl.ts`'s backfill, which runs in the
 * same transaction as the `ADD COLUMN` it fills and therefore replays against
 * the same rows every time — so a real violation fails every attempt and is
 * raised by the last, while an unconditional `INSERT` might succeed on a later
 * one and hide the first failure.
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

async function RunTransaction(
  client: PoolClient,
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  const sequence = [...TRANSACTION_PROLOGUE, ...statements, COMMIT];
  for (const statement of sequence) {
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
 * Runs the statements as one transaction on one client, held for its duration.
 *
 * Nothing between the acquire and the release may touch the pool: every schema
 * of a process converges concurrently against a pool that is typically smaller
 * than their number, so a wait nested inside a held client deadlocks all of
 * them. A client whose `ROLLBACK` did not land is destroyed rather than
 * recycled, since the pool would otherwise hand the next borrower a session
 * still inside an aborted transaction.
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
  const pending: Promise<void> = RetryOnDuplicateObject(() =>
    Apply(REGISTRY_SCHEMA, REGISTRY_STATEMENTS),
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

function WarnOnce(warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (warned.has(warning)) {
      continue;
    }
    warned.add(warning);
    Logger.Warn(warning);
  }
}

async function PlanSchema(
  schemaName: string,
  plans: readonly TablePlan[],
  mode: MigrationMode,
): Promise<ConvergencePlan> {
  const merged: ConvergencePlan = {
    statements: [CreateSchemaSql(schemaName)],
    warnings: [],
  };
  for (const plan of plans) {
    const actual = await ReadTable(schemaName, plan.table);
    const table = PlanTable(schemaName, plan, actual, mode);
    merged.statements.push(...table.statements);
    merged.warnings.push(...table.warnings);
  }
  return merged;
}

async function Converge(
  schemaName: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const merged = await PlanSchema(schemaName, plans, GetOptions().migrations);
  await Apply(schemaName, merged.statements);
  WarnOnce(merged.warnings);
}

/**
 * Brings a registered schema's PostgreSQL objects in line with its definition.
 *
 * The desired plan is a pure function of the definition, so it is built once
 * up front and the retried region is introspect, diff and apply — only the
 * catalog state can go stale between attempts.
 *
 * A duplicate-object failure means another process created something between
 * the introspection and the DDL, which makes the diff stale rather than the
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
