import { expect } from "chai";
import { DatabaseError } from "pg";

import { ExecuteAtomicWrite } from "../../implementations/database/writes-atomic";
import { Root, Write, WrittenSql, CrossInstanceRoot } from "./pipeline-fixture";

const UPDATE = {
  type: "update",
  revisionField: "name",
  expectedRevision: "old",
  nextRevision: "new",
  patch: { age: 29 },
} as const;

describe("the atomic mutation statement", () => {
  it("puts identity, instance and revision directly on the target row", () => {
    const write = Write(Root().atomicMutation("one", UPDATE));
    const sql = WrittenSql(write);
    expect(sql).to.include(
      'WHERE "w0"."_instance" = ($1::text) AND "w0"."_id" = ($2::text) AND "w0"."name" = ($3::text)',
    );
    expect(sql).to.include('RETURNING "w0"."_id"');
    expect(sql).not.to.include("SELECT");
    expect(sql).not.to.include("ON CONFLICT");
    expect(write.context.params.all()).to.deep.equal([
      "",
      "one",
      "old",
      29,
      "new",
    ]);
  });

  it("refuses cross-instance and reserved-column changes", () => {
    expect(() => CrossInstanceRoot().atomicMutation("one", UPDATE)).to.throw();
    expect(() =>
      Write(
        Root().atomicMutation("one", {
          ...UPDATE,
          patch: { _instance: "other" },
        } as never),
      ),
    ).to.throw();
    expect(() =>
      Write(
        Root().atomicMutation("one", {
          ...UPDATE,
          patch: { _extra: {} },
        } as never),
      ),
    ).to.throw();
  });

  it("rejects nonconstant data and direct revision changes", () => {
    for (const patch of [
      { age: undefined },
      { age: () => 1 },
      { name: "bypass" },
    ]) {
      expect(() =>
        Write(Root().atomicMutation("one", { ...UPDATE, patch } as never)),
      ).to.throw();
    }
  });
});

describe("atomic mutation acknowledgement loss", () => {
  it("throws a definitive PostgreSQL error response", async () => {
    const error = new DatabaseError("constraint violation", 0, "error");
    error.severity = "ERROR";
    try {
      await ExecuteAtomicWrite("UPDATE", [], async () => {
        throw error;
      });
      expect.fail("expected the definitive error");
    } catch (caught) {
      expect(caught).to.equal(error);
    }
  });

  it("returns unknown on a rejected dispatch and never retries", async () => {
    let calls = 0;
    const outcome = await ExecuteAtomicWrite("UPDATE", [], async () => {
      calls++;
      throw new Error("connection terminated after dispatch");
    });
    expect(outcome).to.equal("unknown");
    expect(calls).to.equal(1);
  });
});
