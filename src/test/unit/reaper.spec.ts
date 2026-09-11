import { expect } from "chai";
import type { ClientBase, QueryResult } from "pg";

import { EnsureTriggers } from "../../implementations/database/migrate";
import { ReapInterval, ReapOnce } from "../../implementations/database/reaper";

const RETENTION_MS = 300_000;

/**
 * A table no registration can create, so the install fails the same way under both test commands.
 *
 * These specs share a process with a live adapter under `pnpm test`, where a
 * plausible schema id could genuinely exist and the install would then *succeed* — a spec whose
 * outcome depends on which command ran it is worse than the gap it covers.
 */
const SCHEMA_ID = "__spec_absent";
const TABLE_ID = "__spec_absent";

interface Statement {
  readonly sql: string;
  readonly params: unknown[];
}

type Answer = (sql: string) => unknown[];

const NOTHING: unknown[] = [];

function Rows(rows: unknown[]): QueryResult {
  return { rows } as unknown as QueryResult;
}

/** A client that records what it was asked and answers from a per-statement table. */
function Recording(
  answer: Answer,
  fail?: (sql: string) => boolean,
): {
  client: ClientBase;
  statements: Statement[];
} {
  const statements: Statement[] = [];
  const client = {
    query: (sql: string, params: unknown[] = NOTHING) => {
      statements.push({ sql, params });
      if (fail?.(sql)) {
        return Promise.reject(new Error("the pass failed here"));
      }
      return Promise.resolve(Rows(answer(sql)));
    },
  } as unknown as ClientBase;
  return { client, statements };
}

function Answering(present: boolean, took: boolean): Answer {
  return (sql) => {
    if (sql.includes("to_regclass")) {
      return [{ present }];
    }
    if (sql.includes("pg_try_advisory_lock")) {
      return [{ took }];
    }
    return NOTHING;
  };
}

function Kinds(statements: readonly Statement[]): string[] {
  return statements.map(({ sql }) => {
    if (sql.includes("to_regclass")) {
      return "present";
    }
    if (sql.includes("pg_try_advisory_lock")) {
      return "lock";
    }
    if (sql.includes("pg_advisory_unlock")) {
      return "unlock";
    }
    return "reap";
  });
}

describe("the change log's reaper", () => {
  it("does nothing at all against a database that has never run the bootstrap", async () => {
    const { client, statements } = Recording(Answering(false, true));
    await ReapOnce(client, RETENTION_MS);
    expect(Kinds(statements)).to.deep.equal(["present"]);
  });

  it("does not reap when another process holds the lock, and does not unlock it either", async () => {
    const { client, statements } = Recording(Answering(true, false));
    await ReapOnce(client, RETENTION_MS);
    expect(Kinds(statements)).to.deep.equal(["present", "lock"]);
  });

  it("deletes, records the high-water and unlocks, in that order", async () => {
    const { client, statements } = Recording(Answering(true, true));
    await ReapOnce(client, RETENTION_MS);
    expect(Kinds(statements)).to.deep.equal([
      "present",
      "lock",
      "reap",
      "unlock",
    ]);
  });

  it("gives the lock back when the pass itself throws, which is the path that matters", async () => {
    const { client, statements } = Recording(Answering(true, true), (sql) =>
      sql.startsWith("WITH"),
    );
    await ReapOnce(client, RETENTION_MS).then(
      () => expect.fail("the pass should have raised"),
      () => undefined,
    );
    expect(Kinds(statements)).to.deep.equal([
      "present",
      "lock",
      "reap",
      "unlock",
    ]);
  });

  it("takes and gives back the same lock key", async () => {
    const { client, statements } = Recording(Answering(true, true));
    await ReapOnce(client, RETENTION_MS);
    const [, lock, , unlock] = statements;
    expect(lock.params).to.deep.equal(unlock.params);
  });

  it("binds the retention it was handed rather than reading the configuration mid-pass", async () => {
    const { client, statements } = Recording(Answering(true, true));
    await ReapOnce(client, 1234);
    const reap = statements.find(({ sql }) => sql.startsWith("WITH"));
    expect(reap?.params).to.deep.equal([1234]);
  });

  it("deletes by age and raises the high-water only within one postmaster epoch", async () => {
    const { client, statements } = Recording(Answering(true, true));
    await ReapOnce(client, RETENTION_MS);
    const reap =
      statements.find(({ sql }) => sql.startsWith("WITH"))?.sql ?? "";
    expect(reap).to.contain(
      "\"created_at\" < now() - ($1::bigint * interval '1 millisecond')",
    );
    expect(reap).to.contain(
      'WHEN "r"."postmaster_started_at" = EXCLUDED."postmaster_started_at"',
    );
    expect(reap).to.contain(
      'GREATEST("r"."high_water", EXCLUDED."high_water")',
    );
  });

  it("gives a retention window two passes, and never a zero interval", () => {
    expect(ReapInterval(300_000)).to.equal(150_000);
    expect(ReapInterval(1)).to.equal(1);
  });
});

describe("installing the change log's triggers", () => {
  it("shares one install between every feed that asks for a table at once", () => {
    const first = EnsureTriggers(SCHEMA_ID, TABLE_ID);
    const second = EnsureTriggers(SCHEMA_ID, TABLE_ID);
    expect(second).to.equal(first);
    return first.then(
      () => undefined,
      () => undefined,
    );
  });

  it("does not remember an install that failed, so the next feed retries it", async () => {
    const failed = EnsureTriggers(SCHEMA_ID, TABLE_ID);
    await failed.then(
      () => expect.fail("this spec has no table to install onto"),
      () => undefined,
    );
    const retried = EnsureTriggers(SCHEMA_ID, TABLE_ID);
    expect(retried).to.not.equal(failed);
    return retried.then(
      () => undefined,
      () => undefined,
    );
  });
});
