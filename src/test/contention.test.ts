import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "@antelopejs/interface-database/schema";
import { StagedObject } from "@antelopejs/interface-database/common";

import { AcquireClient, Query } from "../connection";
import { CompileWrite, SplitWrite } from "../implementations/database/writes";
import { BuildRoot } from "../implementations/database/selection";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import { CompileExpression } from "../implementations/database/expression";
import { CompileSubquery } from "../implementations/database/subquery";
import { DecodingContext } from "../implementations/database/context";
import { WriteTargetOf } from "../implementations/database/writes-shared";
import { ExecuteAtomicWrite } from "../implementations/database/writes-atomic";

interface RecordValue {
  _id?: string;
  revision?: string;
  value: string;
}

interface Tables {
  records: RecordValue;
  overflow: RecordValue;
}

const schema = new Schema<Tables>("atomic_contention", {
  records: { fields: { revision: "string", value: "string" }, indexes: {} },
  overflow: { fields: { value: "string" }, indexes: {} },
});
const table = schema.instance("tenant").table("records");
const ID = "record";
const LOCK_TIMEOUT_MS = 5000;
const POLL_MS = 10;

async function WaitForLock(pid: number): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await Query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") {
      return;
    }
    await delay(POLL_MS);
  }
  throw new Error("competing writer never waited for the row lock");
}

function Compile(query: StagedObject) {
  const context = new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
  const root = BuildRoot(query.build(), context);
  const split = SplitWrite(root.rest);
  const relation = ApplyStages(root.relation, split.pipeline, context);
  if (!split.write) {
    throw new Error("expected a write");
  }
  return {
    sql: CompileWrite(WriteTargetOf(root, relation), split.write, context).sql,
    params: context.params.all(),
  };
}

async function Compete(query: StagedObject, winner?: StagedObject) {
  const first = await AcquireClient();
  const second = await AcquireClient();
  const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  try {
    await first.query("BEGIN");
    const a = Compile(
      winner ??
        table
          .filter((row) => row.key("revision").eq("old"))
          .update({ revision: "next", value: "writer-a" }),
    );
    expect((await first.query(a.sql, a.params)).rowCount).to.equal(1);
    const b = Compile(query);
    const pending = winner
      ? ExecuteAtomicWrite(b.sql, b.params, second.query.bind(second))
      : second.query(b.sql, b.params).then((result) => result.rowCount);
    void pending.catch(() => {});
    await WaitForLock(pid);
    await first.query("COMMIT");
    return await pending;
  } finally {
    await first.query("ROLLBACK");
    first.release();
    second.release();
  }
}

describe("legacy conditional writes under contention", () => {
  beforeEach(async () => {
    await table.delete();
    await table.insert({
      _id: ID,
      revision: "old",
      value: "initial",
    } as RecordValue);
  });

  it("reproduces two different patches matching one stale revision", async () => {
    const result = await Compete(
      table
        .filter((row) => row.key("revision").eq("old"))
        .update({ revision: "next", value: "writer-b" }),
    );
    expect(result).to.equal(1);
    expect((await table.get(ID))?.value).to.equal("writer-b");
  });

  it("reproduces a stale conditional delete removing an updated row", async () => {
    const result = await Compete(
      table.filter((row) => row.key("revision").eq("old")).delete(),
    );
    expect(result).to.equal(1);
    expect(await table.get(ID)).to.equal(undefined);
  });
});

describe("atomic mutations under contention", () => {
  beforeEach(async () => {
    await table.delete();
    await table.insert({
      _id: ID,
      revision: "old",
      value: "initial",
    } as RecordValue);
  });

  function Winner() {
    return table.atomicMutation(ID, {
      type: "update",
      revisionField: "revision",
      expectedRevision: "old",
      nextRevision: "next-a",
      patch: { value: "writer-a" },
    });
  }

  it("allows only one different patch for the same revision", async () => {
    const second = table.atomicMutation(ID, {
      type: "update",
      revisionField: "revision",
      expectedRevision: "old",
      nextRevision: "next-b",
      patch: { value: "writer-b" },
    });
    expect(await Compete(second, Winner())).to.equal("not-applied");
    const record = await table.get(ID);
    expect(record?.revision).to.equal("next-a");
    expect(record?.value).to.equal("writer-a");
  });

  it("does not delete a row whose revision changed while waiting", async () => {
    const second = table.atomicMutation(ID, {
      type: "delete",
      revisionField: "revision",
      expectedRevision: "old",
    });
    expect(await Compete(second, Winner())).to.equal("not-applied");
    expect((await table.get(ID))?.value).to.equal("writer-a");
  });

  it("rechecks scalar equality after a concurrent update", async () => {
    const second = table.atomicMutation(ID, {
      type: "deleteIfEqual",
      field: "value",
      expectedValue: "initial",
    });
    expect(await Compete(second, Winner())).to.equal("not-applied");
    expect((await table.get(ID))?.value).to.equal("writer-a");
  });

  it("allows only one bootstrap of a missing overflow revision", async () => {
    const overflow = schema.instance("tenant").table("overflow");
    await overflow.delete();
    await overflow.insert({ _id: ID, value: "initial" });
    const request = {
      type: "update",
      revisionField: "revision",
      expectedRevision: { kind: "missing" },
      nextRevision: "next-a",
      patch: { value: "writer-a" },
    } as const;
    const first = overflow.atomicMutation(ID, request);
    const second = overflow.atomicMutation(ID, {
      ...request,
      nextRevision: "next-b",
      patch: { value: "writer-b" },
    });
    expect(await Compete(second, first)).to.equal("not-applied");
    expect((await overflow.get(ID))?.revision).to.equal("next-a");
    expect((await overflow.get(ID))?.value).to.equal("writer-a");
  });

  it("reports unknown when the committed response is lost without retrying", async () => {
    const statement = Compile(Winner());
    let calls = 0;
    const outcome = await ExecuteAtomicWrite(
      statement.sql,
      statement.params,
      async (sql, params) => {
        calls++;
        await Query(sql, params);
        throw new Error("acknowledgement lost");
      },
    );
    expect(outcome).to.equal("unknown");
    expect(calls).to.equal(1);
    expect((await table.get(ID))?.revision).to.equal("next-a");
  });
});
