import type { Measure } from "@antelopejs/interface-database-catalog";
import type { PoolClient, QueryResultRow } from "pg";

import { AcquireClient } from "../../connection";
import { IsDocument, IsString } from "./guards";

const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_MS = 1000;
const SAVEPOINT = "measure";

/** Statement cancelled by `statement_timeout`, and lock wait ended by `lock_timeout`. */
const TIMEOUT_CODES: readonly string[] = ["57014", "55P03"];

let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS;

/**
 * Overrides the per-measure statement timeout, for the suite that proves a slow measure answers
 * `timeout`; no configuration reaches it.
 */
export function SetMeasureTimeoutForTests(ms?: number): void {
  statementTimeoutMs = ms ?? DEFAULT_STATEMENT_TIMEOUT_MS;
}

/** One read-only transaction, its statements each run under a savepoint. */
export interface MeasureSession {
  measure<T extends QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<Measure<T[]>>;
}

function Failed<T>(code: string): Measure<T> {
  return TIMEOUT_CODES.includes(code)
    ? { status: "timeout" }
    : { status: "error", code };
}

function SessionOver(client: PoolClient): MeasureSession {
  return {
    async measure<T extends QueryResultRow>(sql: string, params?: unknown[]) {
      await client.query(`SAVEPOINT ${SAVEPOINT}`);
      try {
        const result = await client.query<T>(sql, params);
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        return { status: "ok", value: result.rows } satisfies Measure<T[]>;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        return Failed<T[]>(
          IsDocument(error) && IsString(error.code) ? error.code : "unknown",
        );
      }
    },
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one call at a time per instance, so profiling never fans out over the client's pool. */
function Serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Runs `work` in a `READ ONLY` transaction with a statement and a lock timeout, and rolls it back:
 * nothing it does can write, whatever the connected role may, and nothing waits on the client's
 * locks for long.
 */
export function WithMeasures<T>(
  work: (session: MeasureSession) => Promise<T>,
): Promise<T> {
  return Serialized(async () => {
    const client = await AcquireClient();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      return await work(SessionOver(client));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
}

/** The first row of a measure, or the measure's failure. */
export function FirstRow<T, R>(
  measured: Measure<T[]>,
  read: (row: T) => R,
): Measure<R> {
  if (measured.status !== "ok") {
    return measured;
  }
  return { status: "ok", value: read(measured.value[0]) };
}

export function Mapped<T, R>(
  measured: Measure<T>,
  read: (value: T) => R,
): Measure<R> {
  return measured.status === "ok"
    ? { status: "ok", value: read(measured.value) }
    : measured;
}

export function ValueOf<T>(measured: Measure<T> | undefined): T | undefined {
  return measured?.status === "ok" ? measured.value : undefined;
}

/** Runs `work` over `items` one after another, never two statements at once. */
export async function Sequentially<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await work(item));
  }
  return results;
}
