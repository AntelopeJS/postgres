import type { TableDefinition } from "@antelopejs/interface-database/schema";
import { expect } from "chai";
import type { MigrationMode } from "../../config";
import {
  type ActualColumn,
  type ActualIndex,
  type ActualTable,
  AssertDistinctNames,
  BuildTablePlan,
  ColumnDdl,
  CreateIndexSql,
  CreateTableSql,
  type IndexPlan,
  IsAdapterIndex,
  PlanTable,
  type TablePlan,
} from "../../implementations/database/ddl";
import { ParseTable } from "../../implementations/database/fields";
import { PgIdentifier } from "../../implementations/database/identifier";
import { FLOAT } from "../../implementations/database/types";

const vehicles: TableDefinition = {
  fields: { car: "string", price: "number", tags: "string[]" },
  indexes: {
    price: {},
    tags: { multi: true },
    byCar: { fields: ["car", "price"] },
  },
};

const VEHICLES_PLAN = BuildTablePlan(
  "vehicles",
  vehicles,
  ParseTable(vehicles, "s.vehicles"),
);

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

function PlanFor(tableId: string, definition: TableDefinition): TablePlan {
  return BuildTablePlan(
    tableId,
    definition,
    ParseTable(definition, `s.${tableId}`),
  );
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

  it("signs an index with its method and keys", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_price");
    expect(index.signature).to.equal(`antelopejs:1:btree:"_instance","price"`);
  });

  it("emits a create table statement with the composite primary key", () => {
    const sql = CreateTableSql("shop", VEHICLES_PLAN);
    expect(sql).to.contain(`CREATE TABLE IF NOT EXISTS "shop"."vehicles" (`);
    expect(sql).to.contain(`PRIMARY KEY ("_instance", "_id")`);
  });

  it("emits a create index statement and its signature comment", () => {
    const index = FindIndex(VEHICLES_PLAN, "vehicles_price");
    expect(CreateIndexSql("shop", VEHICLES_PLAN, index)).to.deep.equal([
      `CREATE INDEX "vehicles_price" ON "shop"."vehicles" USING btree ("_instance", "price")`,
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
    expect(matched, comment).to.not.equal(null);
    expect(DecodeLiteral((matched as RegExpExecArray)[1])).to.equal(
      index.signature,
    );
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

const SAFE: MigrationMode = "safe";
const DESTRUCTIVE: MigrationMode = "destructive";
const SCHEMA = "shop";
const VEHICLES_TARGET = `"shop"."vehicles"`;
const DECLARED_INDEX_COUNT = 3;

const dated: TableDefinition = {
  fields: { manufactured: "date" },
  indexes: {},
};

const everyType: TableDefinition = {
  fields: {
    label: "string",
    amount: "number",
    active: "boolean",
    at: "date",
    payload: "object",
    tags: "string[]",
  },
  indexes: {},
};

const CATALOG_TYPES: Record<string, string> = {
  text: "text",
  "double precision": "double precision",
  boolean: "boolean",
  timestamptz: "timestamp with time zone",
  jsonb: "jsonb",
};

const EMPTY: ActualTable = { columns: [], indexes: [] };

const FULL_COLUMNS: ActualColumn[] = [
  { name: "_id", type: "text" },
  { name: "_instance", type: "text" },
  { name: "car", type: "text" },
  { name: "price", type: "double precision" },
  { name: "tags", type: "jsonb" },
  { name: "_extra", type: "jsonb" },
];

const RETYPED_COLUMNS: ActualColumn[] = FULL_COLUMNS.map((column) =>
  column.name === "price" ? { name: column.name, type: "text" } : column,
);

const RETIRED_COLUMNS: ActualColumn[] = [
  ...FULL_COLUMNS,
  { name: "retired", type: "text" },
];

const UNCASTABLE_COLUMNS: ActualColumn[] = FULL_COLUMNS.map((column) =>
  column.name === "price" ? { name: column.name, type: "boolean" } : column,
);

const PRICELESS_COLUMNS: ActualColumn[] = FULL_COLUMNS.filter(
  (column) => column.name !== "price",
);

const DRIFTED_TAGS_INDEX: ActualIndex = {
  name: "vehicles_tags",
  signature: `antelopejs:1:gin:"outdated"`,
};

function Existing(
  columns: ActualColumn[],
  indexes: ActualIndex[] = [],
): ActualTable {
  return { columns, indexes };
}

function SignedIndexes(plan: TablePlan): ActualIndex[] {
  return plan.indexes.map((index) => ({
    name: index.name,
    signature: index.signature,
  }));
}

function CatalogType(type: string): string {
  if (!Object.hasOwn(CATALOG_TYPES, type)) {
    throw new Error(`No catalog spelling recorded for physical type '${type}'`);
  }
  return CATALOG_TYPES[type];
}

function CatalogColumns(plan: TablePlan): ActualColumn[] {
  return plan.columns.map((column) => ({
    name: column.name,
    type: CatalogType(column.type),
  }));
}

type StatementPredicate = (sql: string) => boolean;

const IsIndexDrop: StatementPredicate = (sql) => sql.startsWith("DROP INDEX");
const IsColumnChange: StatementPredicate = (sql) =>
  sql.startsWith("ALTER TABLE");
const IsIndexCreate: StatementPredicate = (sql) =>
  sql.startsWith("CREATE INDEX") || sql.startsWith("COMMENT ON INDEX");

function FirstAt(statements: string[], matches: StatementPredicate): number {
  const position = statements.findIndex(matches);
  if (position < 0) {
    throw new Error(`No statement matched: ${statements.join(" | ")}`);
  }
  return position;
}

function LastAt(statements: string[], matches: StatementPredicate): number {
  return statements.reduce(
    (found, sql, position) => (matches(sql) ? position : found),
    FirstAt(statements, matches),
  );
}

describe("PlanTable", () => {
  it("creates everything when the table is absent", () => {
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, EMPTY, SAFE);
    expect(out.statements[0]).to.contain("CREATE TABLE IF NOT EXISTS");
    expect(
      out.statements.filter((sql) => sql.startsWith("CREATE INDEX")),
    ).to.have.lengthOf(DECLARED_INDEX_COUNT);
    expect(out.warnings).to.deep.equal([]);
  });

  it("adds only the missing columns", () => {
    const actual = Existing([
      { name: "_id", type: "text" },
      { name: "_instance", type: "text" },
      { name: "car", type: "text" },
      { name: "_extra", type: "jsonb" },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    const added = out.statements.filter((sql) => sql.includes("ADD COLUMN"));
    expect(added).to.deep.equal([
      `ALTER TABLE ${VEHICLES_TARGET} ADD COLUMN IF NOT EXISTS "price" double precision`,
      `ALTER TABLE ${VEHICLES_TARGET} ADD COLUMN IF NOT EXISTS "tags" jsonb`,
    ]);
  });

  /**
   * Without this the existing rows stayed self-inconsistent forever: `DecodeRow` merges the overflow
   * document last, so the row went on displaying the pre-column copy while `filter` and `getAll`
   * read the new empty column and matched nothing.
   */
  it("moves each added column's field out of the overflow document, in the same transaction", () => {
    const actual = Existing([
      { name: "_id", type: "text" },
      { name: "_instance", type: "text" },
      { name: "car", type: "text" },
      { name: "_extra", type: "jsonb" },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    const filled = out.statements.filter((sql) => sql.startsWith("UPDATE"));
    expect(filled).to.have.lengthOf(2);
    expect(filled[0]).to.contain(`UPDATE ${VEHICLES_TARGET} SET "price" =`);
    expect(filled[0]).to.contain(`"_extra" = "_extra" - 'price'`);
    expect(filled[0]).to.contain(`WHERE "price" IS NULL`);
    const added = out.statements.indexOf(
      out.statements.filter((sql) => sql.includes(`"price"`))[0],
    );
    expect(out.statements[added + 1]).to.equal(filled[0]);
  });

  it("reads the stored value as the column's type, so a mistyped one stays put", () => {
    const actual = Existing([
      { name: "_id", type: "text" },
      { name: "_instance", type: "text" },
      { name: "car", type: "text" },
      { name: "tags", type: "jsonb" },
      { name: "_extra", type: "jsonb" },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    const filled = out.statements.filter((sql) => sql.startsWith("UPDATE"));
    expect(filled).to.have.lengthOf(1);
    expect(filled[0]).to.contain("jsonb_typeof");
    expect(filled[0]).to.contain("IS NOT NULL");
    expect(filled[0]).to.contain("'null'::jsonb");
  });

  it("plans no backfill where nothing was added", () => {
    const actual = Existing([
      { name: "_id", type: "text" },
      { name: "_instance", type: "text" },
      { name: "car", type: "text" },
      { name: "price", type: "double precision" },
      { name: "tags", type: "jsonb" },
      { name: "_extra", type: "jsonb" },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(
      out.statements.filter((sql) => sql.startsWith("UPDATE")),
    ).to.deep.equal([]);
  });

  it("accepts the catalog spelling of a timestamp column", () => {
    const plan = BuildTablePlan("v", dated, ParseTable(dated, "s.v"));
    const actual = Existing([
      { name: "_id", type: "text" },
      { name: "_instance", type: "text" },
      { name: "manufactured", type: "timestamp with time zone" },
      { name: "_extra", type: "jsonb" },
    ]);
    expect(PlanTable(SCHEMA, plan, actual, SAFE).statements).to.deep.equal([]);
  });

  it("accepts the catalog spelling of every physical type", () => {
    const plan = BuildTablePlan("v", everyType, ParseTable(everyType, "s.v"));
    const actual = Existing(CatalogColumns(plan));
    expect(PlanTable(SCHEMA, plan, actual, SAFE).statements).to.deep.equal([]);
  });

  it("refuses a type change in safe mode, naming the field", () => {
    const actual = Existing(RETYPED_COLUMNS);
    const converge = () => PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(converge).to.throw(/price/);
    expect(converge).to.throw(/destructive/);
  });

  it("alters a changed type in destructive mode", () => {
    const actual = Existing(RETYPED_COLUMNS);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, DESTRUCTIVE);
    expect(out.statements).to.contain(
      `ALTER TABLE ${VEHICLES_TARGET} ALTER COLUMN "price" TYPE double precision USING ("price"::text::double precision)`,
    );
  });

  it("routes the destructive cast through text when no direct cast exists", () => {
    const actual = Existing(UNCASTABLE_COLUMNS);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, DESTRUCTIVE);
    expect(out.statements).to.contain(
      `ALTER TABLE ${VEHICLES_TARGET} ALTER COLUMN "price" TYPE double precision USING ("price"::text::double precision)`,
    );
  });

  it("refuses to add a not-null column with no default to a live table", () => {
    const actual = Existing(
      FULL_COLUMNS.filter((column) => column.name !== "_id"),
    );
    const converge = () =>
      PlanTable(SCHEMA, VEHICLES_PLAN, actual, DESTRUCTIVE);
    expect(converge).to.throw(/_id/);
    expect(converge).to.throw(/not created by this adapter/);
  });

  it("warns about an undeclared column in safe mode and keeps it", () => {
    const actual = Existing(RETIRED_COLUMNS, SignedIndexes(VEHICLES_PLAN));
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.deep.equal([]);
    expect(out.warnings[0]).to.match(/retired/);
  });

  it("drops an undeclared column in destructive mode", () => {
    const actual = Existing(RETIRED_COLUMNS, SignedIndexes(VEHICLES_PLAN));
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, DESTRUCTIVE);
    expect(out.statements).to.contain(
      `ALTER TABLE ${VEHICLES_TARGET} DROP COLUMN "retired"`,
    );
  });

  it("leaves a matching index alone", () => {
    const actual = Existing(FULL_COLUMNS, [
      {
        name: "vehicles_price",
        signature: `antelopejs:1:btree:"_instance","price"`,
      },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(
      out.statements.some((sql) => sql.includes("vehicles_price")),
    ).to.equal(false);
  });

  it("recreates an index whose signature drifted", () => {
    const actual = Existing(FULL_COLUMNS, [
      { name: "vehicles_price", signature: `antelopejs:1:btree:"price"` },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.contain(
      `DROP INDEX IF EXISTS "shop"."vehicles_price"`,
    );
    expect(
      out.statements.some((sql) =>
        sql.startsWith(`CREATE INDEX "vehicles_price"`),
      ),
    ).to.equal(true);
  });

  it("recreates an index we own but never signed", () => {
    const actual = Existing(FULL_COLUMNS, [{ name: "vehicles_price" }]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.contain(
      `DROP INDEX IF EXISTS "shop"."vehicles_price"`,
    );
  });

  it("drops an adapter index whose declaration is gone", () => {
    const actual = Existing(FULL_COLUMNS, [
      {
        name: "vehicles_retired",
        signature: `antelopejs:1:btree:"_instance","retired"`,
      },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.contain(
      `DROP INDEX IF EXISTS "shop"."vehicles_retired"`,
    );
  });

  it("leaves a hand-made index alone", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...SignedIndexes(VEHICLES_PLAN),
      { name: "operator_hunch" },
    ]);
    expect(
      PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE).statements,
    ).to.deep.equal([]);
  });

  it("drops every index before it touches a column, and creates after", () => {
    const actual = Existing(PRICELESS_COLUMNS, [DRIFTED_TAGS_INDEX]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(LastAt(out.statements, IsIndexDrop)).to.be.lessThan(
      FirstAt(out.statements, IsColumnChange),
    );
    expect(LastAt(out.statements, IsColumnChange)).to.be.lessThan(
      FirstAt(out.statements, IsIndexCreate),
    );
  });

  it("drops a drifted index before recreating it", () => {
    const actual = Existing(FULL_COLUMNS, [
      { name: "vehicles_price", signature: `antelopejs:1:btree:"price"` },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    const dropped = out.statements.indexOf(
      `DROP INDEX IF EXISTS "shop"."vehicles_price"`,
    );
    const created = out.statements.findIndex((sql) =>
      sql.startsWith(`CREATE INDEX "vehicles_price"`),
    );
    expect(dropped).to.be.greaterThan(-1);
    expect(dropped).to.be.lessThan(created);
  });

  it("emits nothing against the state its own creation produces", () => {
    const actual = Existing(
      CatalogColumns(VEHICLES_PLAN),
      SignedIndexes(VEHICLES_PLAN),
    );
    expect(PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE)).to.deep.equal({
      statements: [],
      warnings: [],
    });
  });
});
