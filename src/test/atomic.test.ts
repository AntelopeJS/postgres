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
  await table.insert({ _id: ID, value: "before", ...document }).run();
}

describe("atomic mutation results and scope", () => {
  beforeEach(async () => {
    await table.delete().run();
  });

  it("persists inserted overflow revisions and replaces nested fields as a whole", async () => {
    await Seed({ revision: "old", details: { removed: true } });
    expect((await table.get(ID).run())?.revision).to.equal("old");
    expect(await table.atomicMutation(ID, update).run()).to.equal("applied");
    expect(await table.get(ID).run()).to.include({
      revision: "fresh",
      value: "after",
    });
    const rows = await table
      .filter((row) => row.key("revision").eq("fresh"))
      .run();
    expect(rows).to.have.length(1);
    expect(rows[0].revision).to.equal("fresh");
    expect(rows[0].details).to.deep.equal({ kept: true });
  });

  it("bootstraps absent overflow revisions but not stored null or an absent row", async () => {
    const request = {
      ...update,
      expectedRevision: { kind: "missing" } as const,
    };
    expect(await table.atomicMutation(ID, request).run()).to.equal(
      "not-applied",
    );
    await Seed({ revision: null });
    expect(await table.atomicMutation(ID, request).run()).to.equal(
      "not-applied",
    );
    await table.get(ID).update({ revision: undefined }).run();
    expect(await table.atomicMutation(ID, request).run()).to.equal("applied");
    expect((await table.get(ID).run())?.revision).to.equal("fresh");
  });

  it("rejects missing-revision bootstrap on declared columns", async () => {
    try {
      await schema
        .instance()
        .table("declared")
        .atomicMutation(ID, {
          ...update,
          expectedRevision: { kind: "missing" },
        })
        .run();
      expect.fail("expected unsupported bootstrap");
    } catch (error) {
      expect(String(error)).to.include(
        "Missing revision bootstrap is unsupported",
      );
    }
  });

  it("supports the default instance and refuses cross-instance mutation", async () => {
    const defaults = schema.instance().table("records");
    await defaults.delete().run();
    await defaults.insert({ _id: ID, revision: "old" }).run();
    expect(await defaults.atomicMutation(ID, update).run()).to.equal("applied");
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
    await table.delete().run();
  });

  it("compares declared dates by instant and leaves a changed date untouched", async () => {
    const declared = schema.instance().table("declared");
    await declared.delete().run();
    const updatedAt = new Date("2026-01-05T10:00:00+02:00");
    await declared.insert({ _id: ID, updatedAt }).run();
    expect(
      await declared
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "updatedAt",
          expectedValue: new Date("2026-01-05T08:00:01Z"),
        })
        .run(),
    ).to.equal("not-applied");
    expect(
      await declared
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "updatedAt",
          expectedValue: new Date("2026-01-05T08:00:00Z"),
        })
        .run(),
    ).to.equal("applied");
  });

  it("preserves scalar types in overflow equality and ignores missing fields", async () => {
    await Seed({ attempts: 7, active: true });
    expect(
      await table
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "updatedAt",
          expectedValue: new Date(),
        })
        .run(),
    ).to.equal("not-applied");
    expect(
      await table
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "attempts",
          expectedValue: "7",
        })
        .run(),
    ).to.equal("not-applied");
    expect(
      await table
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "active",
          expectedValue: false,
        })
        .run(),
    ).to.equal("not-applied");
    expect(
      await table
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "attempts",
          expectedValue: 7,
        })
        .run(),
    ).to.equal("applied");
  });

  it("matches dates stored in overflow by the native insert compiler", async () => {
    const updatedAt = new Date("2026-02-12T03:04:05Z");
    await Seed({ updatedAt });
    expect(
      await table
        .atomicMutation(ID, {
          type: "deleteIfEqual",
          field: "updatedAt",
          expectedValue: updatedAt,
        })
        .run(),
    ).to.equal("applied");
  });
});
