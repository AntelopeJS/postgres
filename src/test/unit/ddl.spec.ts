import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import { FLOAT } from "../../implementations/database/types";
import { ParseTable } from "../../implementations/database/fields";
import { PgIdentifier } from "../../implementations/database/identifier";
import {
  AssertDistinctNames,
  ColumnDdl,
  CreateIndexSql,
  CreateTableSql,
  type IndexPlan,
  IsAdapterIndex,
  ServesCrossInstance,
  type TablePlan,
} from "../../implementations/database/ddl";
import { PlanFor, VEHICLES_PLAN, vehicles } from "./ddl-fixture";

const TABLE_PREFIX = "t_";
const ESCAPED_LITERAL_PREFIX = "E'";
const COMMENT_PATTERN = /^COMMENT ON INDEX "shop"\."[^"]+" IS (E?'.*')$/;

function FindIndex(plan: TablePlan, name: string): IndexPlan {
  const found = plan.indexes.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`The plan has no index named '${name}'`);
  }
  return found;
}

function BuildOne(definition: TableDefinition): IndexPlan {
  return PlanFor("t", definition).indexes[0];
}

function DecodeLiteral(literal: string): string {
  const isEscaped = literal.startsWith(ESCAPED_LITERAL_PREFIX);
  const body = literal.slice(isEscaped ? ESCAPED_LITERAL_PREFIX.length : 1, -1);
  const unquoted = body.replace(/''/g, "'");
  return isEscaped ? unquoted.replace(/\\\\/g, "\\") : unquoted;
}

describe("BuildTablePlan", () => {
  it("orders the reserved columns around the declared ones", () => {
    expect(VEHICLES_PLAN.columns.map((column) => column.name)).to.deep.equal([
      "_id",
      "_instance",
      "car",
      "price",
      "tags",
      "_extra",
    ]);
  });

  it("maps declared fields to their physical types", () => {
    expect(VEHICLES_PLAN.columns[3]).to.deep.equal({
      name: "price",
      type: "double precision",
      declared: { field: "price", type: FLOAT },
    });
  });

  it("leaves the reserved columns undeclared, since no field is stored in them", () => {
    const reserved = [0, 1, VEHICLES_PLAN.columns.length - 1];
    for (const at of reserved) {
      expect(VEHICLES_PLAN.columns[at].declared).to.equal(undefined);
    }
  });

  it("gives the reserved columns their constraints", () => {
    expect(ColumnDdl(VEHICLES_PLAN.columns[1])).to.equal(
      `"_instance" text NOT NULL DEFAULT ''`,
    );
    expect(ColumnDdl(VEHICLES_PLAN.columns[5])).to.equal(
      `"_extra" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    expect(ColumnDdl(VEHICLES_PLAN.columns[3])).to.equal(
      `"price" double precision`,
    );
  });

  it("leads a btree index with _instance", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_price");
    expect(index.method).to.equal("btree");
    expect(index.keys).to.deep.equal([`"_instance"`, `"price"`]);
  });

  it("uses a bare gin index for a multi index over a jsonb field", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_tags");
    expect(index.method).to.equal("gin");
    expect(index.keys).to.deep.equal([`"tags"`]);
  });

  it("expands a compound index in declaration order", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_byCar");
    expect(index.keys).to.deep.equal([`"_instance"`, `"car"`, `"price"`]);
  });

  it("indexes an undeclared field through _extra", () => {
    const out = PlanFor("t", { fields: {}, indexes: { ref: {} } });
    expect(out.indexes[0].keys).to.deep.equal([
      `"_instance"`,
      `("_extra" -> 'ref')`,
    ]);
  });

  it("indexes _id on the real column, not through _extra", () => {
    const index = BuildOne({ fields: {}, indexes: { _id: {} } });
    expect(index.keys).to.deep.equal([`"_instance"`, `"_id"`]);
  });

  it("rejects an index over a reserved column that is not _id", () => {
    for (const reserved of ["_instance", "_extra"]) {
      const build = () => BuildOne({ fields: {}, indexes: { [reserved]: {} } });
      expect(build).to.throw(reserved);
      expect(build).to.throw(/reserved/);
    }
  });

  it("falls back to the index id when fields is explicitly empty", () => {
    const index = BuildOne({
      fields: { car: "string" },
      indexes: { car: { fields: [] } },
    });
    expect(index.keys).to.deep.equal([`"_instance"`, `"car"`]);
  });

  it("falls back to btree for multi over a scalar field", () => {
    const index = BuildOne({
      fields: { car: "string" },
      indexes: { car: { multi: true } },
    });
    expect(index.method).to.equal("btree");
    expect(index.keys).to.deep.equal([`"_instance"`, `"car"`]);
  });

  it("falls back to btree for multi over an undeclared field", () => {
    const index = BuildOne({ fields: {}, indexes: { ref: { multi: true } } });
    expect(index.method).to.equal("btree");
    expect(index.keys).to.deep.equal([`"_instance"`, `("_extra" -> 'ref')`]);
  });
});

describe("BuildTablePlan", () => {
  it("adds an unprefixed __g twin to a crossInstance btree index", () => {
    const plan = PlanFor("t", {
      fields: { car: "string", price: "number" },
      indexes: { byCar: { fields: ["car", "price"], crossInstance: true } },
    });
    expect(plan.indexes.map((index) => index.name)).to.deep.equal([
      "t_byCar",
      "t_byCar__g",
    ]);
    const [scoped, unscoped] = plan.indexes;
    expect(scoped.keys).to.deep.equal([`"_instance"`, `"car"`, `"price"`]);
    expect(unscoped.keys).to.deep.equal([`"car"`, `"price"`]);
    expect(unscoped.signature).to.equal(`antelopejs:1:btree:"car","price"`);
    expect(unscoped.signature).to.not.equal(scoped.signature);
  });

  it("keeps a crossInstance gin index as one bare index", () => {
    const plan = PlanFor("t", {
      fields: { tags: "string[]" },
      indexes: { tags: { multi: true, crossInstance: true } },
    });
    expect(plan.indexes.map((index) => index.name)).to.deep.equal(["t_tags"]);
    expect(plan.indexes[0].method).to.equal("gin");
  });

  it("fits the __g name into the identifier limit", () => {
    const longId = "x".repeat(70);
    const plan = PlanFor("t", {
      fields: {},
      indexes: { [longId]: { crossInstance: true } },
    });
    const names = plan.indexes.map((index) => index.name);
    expect(names[0]).to.equal(PgIdentifier(`t_${longId}`));
    expect(names[1]).to.equal(PgIdentifier(`${names[0]}__g`));
    expect(Buffer.byteLength(names[1])).to.be.at.most(63);
  });

  it("signs an index with its method and keys", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_price");
    expect(index.signature).to.equal(`antelopejs:1:btree:"_instance","price"`);
  });

  it("emits a create table statement with the composite primary key", () => {
    const sql = CreateTableSql("shop", VEHICLES_PLAN);
    expect(sql).to.contain(`CREATE TABLE IF NOT EXISTS "shop"."vehicles" (`);
    expect(sql).to.contain(`PRIMARY KEY ("_instance", "_id")`);
  });

  it("emits a concurrent create index statement and its signature comment", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_price");
    expect(CreateIndexSql("shop", VEHICLES_PLAN, index)).to.deep.equal([
      `CREATE INDEX CONCURRENTLY "vehicles_price" ON "shop"."vehicles" USING btree ("_instance", "price")`,
      `COMMENT ON INDEX "shop"."vehicles_price" IS 'antelopejs:1:btree:"_instance","price"'`,
    ]);
  });

  it("round-trips a signature over a hostile field name", () => {
    const hostile = "it's\\bad";
    const hostilePlan = PlanFor("t", {
      fields: {},
      indexes: { [hostile]: {} },
    });
    const index = hostilePlan.indexes[0];
    const comment = CreateIndexSql("shop", hostilePlan, index)[1];
    const matched = COMMENT_PATTERN.exec(comment);
    if (matched === null) {
      expect.fail(comment);
    }
    expect(DecodeLiteral(matched[1])).to.equal(index.signature);
  });

  it("builds a unique index keyed by instance, with a marked signature", () => {
    const plan = PlanFor("t", {
      fields: { email: "string" },
      indexes: { email: { unique: true } },
    });
    const [index] = plan.indexes;
    expect(index.isUnique).to.equal(true);
    expect(index.signature).to.equal(
      `antelopejs:1:btree:unique:"_instance","email"`,
    );
    expect(CreateIndexSql("shop", plan, index)[0]).to.equal(
      `CREATE UNIQUE INDEX CONCURRENTLY "t_email" ON "shop"."t" USING btree ("_instance", "email")`,
    );
  });

  it("keeps the __g twin of a unique index non-unique", () => {
    const plan = PlanFor("t", {
      fields: { email: "string" },
      indexes: { email: { unique: true, crossInstance: true } },
    });
    const [scoped, unscoped] = plan.indexes;
    expect(scoped.isUnique).to.equal(true);
    expect(unscoped.name).to.equal("t_email__g");
    expect(unscoped.isUnique).to.equal(false);
    expect(CreateIndexSql("shop", plan, unscoped)[0]).to.match(
      /^CREATE INDEX CONCURRENTLY/,
    );
  });

  it("refuses a unique index over an array field's elements", () => {
    expect(() =>
      BuildOne({
        fields: { tags: "string[]" },
        indexes: { tags: { multi: true, unique: true } },
      }),
    ).to.throw(/unique and multi over an array field/);
  });
});

describe("ServesCrossInstance", () => {
  const model = ParseTable(vehicles, "s.vehicles");

  it("is true for a declared crossInstance index", () => {
    expect(
      ServesCrossInstance("price", { crossInstance: true }, model),
    ).to.equal(true);
  });

  it("is false for a btree index that is not crossInstance", () => {
    expect(ServesCrossInstance("price", {}, model)).to.equal(false);
  });

  it("is true for a gin index, which carries no instance prefix", () => {
    expect(ServesCrossInstance("tags", { multi: true }, model)).to.equal(true);
  });
});

describe("IsAdapterIndex", () => {
  it("recognises a signature we emit", () => {
    const index = BuildOne({ fields: { car: "string" }, indexes: { car: {} } });
    expect(IsAdapterIndex(index.signature)).to.equal(true);
  });

  it("rejects an unsigned index and a foreign comment", () => {
    expect(IsAdapterIndex(undefined)).to.equal(false);
    expect(IsAdapterIndex("built by hand, do not drop")).to.equal(false);
  });

  it("recognises a signature from a future version", () => {
    expect(IsAdapterIndex(`antelopejs:2:btree:"x"`)).to.equal(true);
  });
});

describe("AssertDistinctNames", () => {
  it("accepts a schema whose generated names are all distinct", () => {
    const plans = [
      VEHICLES_PLAN,
      PlanFor("owners", { fields: { name: "string" }, indexes: { name: {} } }),
    ];
    expect(() => AssertDistinctNames(plans)).to.not.throw();
  });

  it("rejects two indexes on one table that collide on one name", () => {
    const long = "i".repeat(100);
    const truncated = PgIdentifier(`${TABLE_PREFIX}${long}`).slice(
      TABLE_PREFIX.length,
    );
    const plan = PlanFor("t", {
      fields: {},
      indexes: { [long]: {}, [truncated]: {} },
    });
    const check = () => AssertDistinctNames([plan]);
    expect(check).to.throw(/is claimed by both/);
    expect(check).to.throw(`index '${long}' on table 't'`);
    expect(check).to.throw(`index '${truncated}' on table 't'`);
  });

  it("rejects two tables whose indexes map to one name", () => {
    const plans = [
      PlanFor("a", { fields: {}, indexes: { b_c: {} } }),
      PlanFor("a_b", { fields: {}, indexes: { c: {} } }),
    ];
    const check = () => AssertDistinctNames(plans);
    expect(check).to.throw("a_b_c");
    expect(check).to.throw(/index 'b_c' on table 'a'/);
    expect(check).to.throw(/index 'c' on table 'a_b'/);
  });

  it("rejects an index that collides with a sibling table", () => {
    const plans = [
      VEHICLES_PLAN,
      PlanFor("vehicles_price", { fields: {}, indexes: {} }),
    ];
    const check = () => AssertDistinctNames(plans);
    expect(check).to.throw("vehicles_price");
    expect(check).to.throw(/index 'price' on table 'vehicles'/);
    expect(check).to.throw(/table 'vehicles_price'/);
  });
});
