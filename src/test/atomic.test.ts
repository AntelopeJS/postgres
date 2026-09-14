import { expect } from "chai";
import type { AtomicUpdate } from "@antelopejs/interface-database/atomic";
import { Schema, CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

interface Document {
  _id: string;
  revision?: string | null;
  value?: string;
  details?: Record<string, boolean>;
  updatedAt?: Date;
  attempts?: number;
  active?: boolean;
}

interface Tables {
  records: Document;
  declared: Document;
}

const schema = new Schema<Tables>("atomic_results", {
  records: { fields: { value: "string" }, indexes: {} },
  declared: {
    fields: { revision: "string", value: "string", updatedAt: "date" },
    indexes: {},
  },
});
const table = schema.instance("tenant").table("records");
const ID = "one";
const update: AtomicUpdate<Document> = {
  type: "update",
  revisionField: "revision",
  expectedRevision: "old",
  nextRevision: "fresh",
  patch: { value: "after", details: { kept: true } },
};

async function Seed(document: Partial<Document> = {}) {
  await table.insert({ _id: ID, value: "before", ...document });
}

describe("atomic mutation results and scope", () => {
  beforeEach(async () => {
    await table.delete();
  });

  it("persists inserted overflow revisions and replaces nested fields as a whole", async () => {
    await Seed({ revision: "old", details: { removed: true } });
    expect((await table.get(ID))?.revision).to.equal("old");
    expect(await table.atomicMutation(ID, update)).to.equal("applied");
    expect(await table.get(ID)).to.include({
      revision: "fresh",
      value: "after",
    });
    const rows = await table.filter((row) => row.key("revision").eq("fresh"));
    expect(rows).to.have.length(1);
    expect(rows[0].revision).to.equal("fresh");
    expect(rows[0].details).to.deep.equal({ kept: true });
  });

  it("never upserts a missing identity", async () => {
    expect(await table.atomicMutation(ID, update)).to.equal("not-applied");
    expect(await table.get(ID)).to.equal(undefined);
  });

  it("does not change wrong-tenant or stale-revision rows", async () => {
    await Seed({ revision: "old" });
    expect(
      await schema
        .instance("other")
        .table("records")
        .atomicMutation(ID, update),
    ).to.equal("not-applied");
    expect(
      await table.atomicMutation(ID, { ...update, expectedRevision: "stale" }),
    ).to.equal("not-applied");
    expect((await table.get(ID))?.value).to.equal("before");
  });

  it("deletes only a matching revision and distinguishes missing rows", async () => {
    await Seed({ revision: "old" });
    const request = {
      type: "delete",
      revisionField: "revision",
      expectedRevision: "old",
    } as const;
    expect(await table.atomicMutation(ID, request)).to.equal("applied");
    expect(await table.atomicMutation(ID, request)).to.equal("not-applied");
  });

  it("bootstraps absent overflow revisions but not stored null or an absent row", async () => {
    const request = {
      ...update,
      expectedRevision: { kind: "missing" } as const,
    };
    expect(await table.atomicMutation(ID, request)).to.equal("not-applied");
    await Seed({ revision: null });
    expect(await table.atomicMutation(ID, request)).to.equal("not-applied");
    await table.get(ID).update({ revision: undefined });
    expect(await table.atomicMutation(ID, request)).to.equal("applied");
    expect((await table.get(ID))?.revision).to.equal("fresh");
  });

  it("rejects missing-revision bootstrap on declared columns", async () => {
    try {
      await schema
        .instance()
        .table("declared")
        .atomicMutation(ID, {
          ...update,
          expectedRevision: { kind: "missing" },
        });
      expect.fail("expected unsupported bootstrap");
    } catch (error) {
      expect(String(error)).to.include(
        "Missing revision bootstrap is unsupported",
      );
    }
  });

  it("supports the default instance and refuses cross-instance mutation", async () => {
    const defaults = schema.instance().table("records");
    await defaults.delete();
    await defaults.insert({ _id: ID, revision: "old" });
    expect(await defaults.atomicMutation(ID, update)).to.equal("applied");
    expect(() =>
      schema
        .instance(CROSS_INSTANCE)
        .table("records")
        .atomicMutation(ID, update),
    ).to.throw();
  });
});

describe("atomic scalar equality deletes", () => {
  beforeEach(async () => {
    await table.delete();
  });

  it("compares declared dates by instant and leaves a changed date untouched", async () => {
    const declared = schema.instance().table("declared");
    await declared.delete();
    const updatedAt = new Date("2026-01-05T10:00:00+02:00");
    await declared.insert({ _id: ID, updatedAt });
    expect(
      await declared.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "updatedAt",
        expectedValue: new Date("2026-01-05T08:00:01Z"),
      }),
    ).to.equal("not-applied");
    expect(
      await declared.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "updatedAt",
        expectedValue: new Date("2026-01-05T08:00:00Z"),
      }),
    ).to.equal("applied");
  });

  it("preserves scalar types in overflow equality and ignores missing fields", async () => {
    await Seed({ attempts: 7, active: true });
    expect(
      await table.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "updatedAt",
        expectedValue: new Date(),
      }),
    ).to.equal("not-applied");
    expect(
      await table.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "attempts",
        expectedValue: "7",
      }),
    ).to.equal("not-applied");
    expect(
      await table.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "active",
        expectedValue: false,
      }),
    ).to.equal("not-applied");
    expect(
      await table.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "attempts",
        expectedValue: 7,
      }),
    ).to.equal("applied");
  });

  it("matches dates stored in overflow by the native insert compiler", async () => {
    const updatedAt = new Date("2026-02-12T03:04:05Z");
    await Seed({ updatedAt });
    expect(
      await table.atomicMutation(ID, {
        type: "deleteIfEqual",
        field: "updatedAt",
        expectedValue: updatedAt,
      }),
    ).to.equal("applied");
  });
});
