import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import type { MigrationMode } from "../../config";
import { ParseTable } from "../../implementations/database/fields";
import {
  BuildTablePlan,
  type TablePlan,
} from "../../implementations/database/ddl";
import {
  type ActualColumn,
  type ActualIndex,
  type ActualTable,
  PlanTable,
} from "../../implementations/database/convergence";
import { PlanFor, VEHICLES_PLAN, vehicles } from "./ddl-fixture";

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

const CATALOG_TYPES = new Map([
  ["text", "text"],
  ["double precision", "double precision"],
  ["boolean", "boolean"],
  ["timestamptz", "timestamp with time zone"],
  ["jsonb", "jsonb"],
]);

const EMPTY: ActualTable = { columns: [], indexes: [] };

const FULL_COLUMNS: ActualColumn[] = [
  { name: "_id", type: "text" },
  { name: "_instance", type: "text" },
  { name: "car", type: "text" },
  { name: "price", type: "double precision" },
  { name: "tags", type: "jsonb" },
  { name: "_extra", type: "jsonb" },
];

const RETYPED_COLUMNS = FULL_COLUMNS.map((column) =>
  column.name === "price" ? { name: column.name, type: "text" } : column,
);

const RETIRED_COLUMNS: ActualColumn[] = [
  ...FULL_COLUMNS,
  { name: "retired", type: "text" },
];

const UNCASTABLE_COLUMNS = FULL_COLUMNS.map((column) =>
  column.name === "price" ? { name: column.name, type: "boolean" } : column,
);

const DRIFTED_TAGS_INDEX: ActualIndex = {
  name: "vehicles_tags",
  signature: `antelopejs:1:gin:"outdated"`,
  valid: true,
};

const PRICE_SIGNATURE = `antelopejs:1:btree:"_instance","price"`;
const DRIFTED_PRICE_INDEX: ActualIndex = {
  name: "vehicles_price",
  signature: `antelopejs:1:btree:"price"`,
  valid: true,
};
const DROP_PRICE = `DROP INDEX CONCURRENTLY IF EXISTS "shop"."vehicles_price"`;
const DROP_PRICE_REPLACEMENT = `DROP INDEX CONCURRENTLY IF EXISTS "shop"."vehicles_price__next"`;
const CREATE_PRICE = `CREATE INDEX CONCURRENTLY "vehicles_price"`;
const CREATE_PRICE_REPLACEMENT = `CREATE INDEX CONCURRENTLY "vehicles_price__next"`;
const RENAME_PRICE_REPLACEMENT = `ALTER INDEX "shop"."vehicles_price__next" RENAME TO "vehicles_price"`;

function OtherIndexes(plan: TablePlan, name: string): ActualIndex[] {
  return SignedIndexes(plan).filter((index) => index.name !== name);
}

function StartsAt(statements: string[], prefix: string): number {
  return statements.findIndex((sql) => sql.startsWith(prefix));
}

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
    valid: true,
  }));
}

function CatalogType(type: string): string {
  const spelling = CATALOG_TYPES.get(type);
  if (spelling === undefined) {
    throw new Error(`No catalog spelling recorded for physical type '${type}'`);
  }
  return spelling;
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
    expect(out.statements).to.have.lengthOf(1);
    expect(out.statements[0]).to.contain("CREATE TABLE IF NOT EXISTS");
    expect(
      out.indexStatements.filter((sql) =>
        sql.startsWith("CREATE INDEX CONCURRENTLY"),
      ),
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
});

describe("PlanTable", () => {
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
    const actual = Existing(FULL_COLUMNS, SignedIndexes(VEHICLES_PLAN));
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.indexStatements).to.deep.equal([]);
  });

  it("builds indexes outside the transaction", () => {
    const actual = Existing(FULL_COLUMNS);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.deep.equal([]);
    expect(out.indexStatements).to.have.lengthOf(DECLARED_INDEX_COUNT * 2);
  });

  it("builds a drifted index's replacement before it drops the index", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...OtherIndexes(VEHICLES_PLAN, "vehicles_price"),
      DRIFTED_PRICE_INDEX,
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.deep.equal([]);
    expect(out.indexStatements).to.deep.equal([
      `${CREATE_PRICE_REPLACEMENT} ON ${VEHICLES_TARGET} USING btree ("_instance", "price")`,
      `COMMENT ON INDEX "shop"."vehicles_price__next" IS '${PRICE_SIGNATURE}'`,
      DROP_PRICE,
      RENAME_PRICE_REPLACEMENT,
    ]);
  });

  it("replaces an index we own but never signed", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...OtherIndexes(VEHICLES_PLAN, "vehicles_price"),
      { name: "vehicles_price", valid: true },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(StartsAt(out.indexStatements, CREATE_PRICE_REPLACEMENT)).to.equal(0);
    expect(out.indexStatements).to.contain(RENAME_PRICE_REPLACEMENT);
  });

  it("drops and rebuilds an index a failed concurrent build left invalid", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...OtherIndexes(VEHICLES_PLAN, "vehicles_price"),
      { name: "vehicles_price", signature: PRICE_SIGNATURE, valid: false },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.indexStatements[0]).to.equal(DROP_PRICE);
    expect(StartsAt(out.indexStatements, CREATE_PRICE)).to.equal(1);
  });

  it("clears a replacement a failed rebuild left behind", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...SignedIndexes(VEHICLES_PLAN),
      { name: "vehicles_price__next", valid: false },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.indexStatements).to.deep.equal([DROP_PRICE_REPLACEMENT]);
  });

  it("swaps in a ready replacement when a crash left the index missing", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...OtherIndexes(VEHICLES_PLAN, "vehicles_price"),
      { name: "vehicles_price__next", signature: PRICE_SIGNATURE, valid: true },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.indexStatements).to.deep.equal([RENAME_PRICE_REPLACEMENT]);
  });
});

describe("PlanTable", () => {
  it("drops an adapter index whose declaration is gone, after every build", () => {
    const actual = Existing(FULL_COLUMNS, [
      {
        name: "vehicles_retired",
        signature: `antelopejs:1:btree:"_instance","retired"`,
        valid: true,
      },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.indexStatements.at(-1)).to.equal(
      `DROP INDEX CONCURRENTLY IF EXISTS "shop"."vehicles_retired"`,
    );
  });

  it("drops the __g twin once an index is no longer crossInstance", () => {
    const shared = PlanFor("vehicles", {
      fields: vehicles.fields,
      indexes: { ...vehicles.indexes, price: { crossInstance: true } },
    });
    const actual = Existing(FULL_COLUMNS, SignedIndexes(shared));
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.indexStatements).to.deep.equal([
      `DROP INDEX CONCURRENTLY IF EXISTS "shop"."vehicles_price__g"`,
    ]);
  });

  it("rebuilds an index whose unique flag was added, then removed", () => {
    const unique = PlanFor("vehicles", {
      fields: vehicles.fields,
      indexes: { ...vehicles.indexes, price: { unique: true } },
    });
    const added = PlanTable(
      SCHEMA,
      unique,
      Existing(FULL_COLUMNS, SignedIndexes(VEHICLES_PLAN)),
      SAFE,
    );
    expect(added.indexStatements[0]).to.equal(
      `CREATE UNIQUE INDEX CONCURRENTLY "vehicles_price__next" ON ${VEHICLES_TARGET} USING btree ("_instance", "price")`,
    );
    expect(added.indexStatements).to.contain(RENAME_PRICE_REPLACEMENT);
    const removed = PlanTable(
      SCHEMA,
      VEHICLES_PLAN,
      Existing(FULL_COLUMNS, SignedIndexes(unique)),
      SAFE,
    );
    expect(
      StartsAt(removed.indexStatements, CREATE_PRICE_REPLACEMENT),
    ).to.equal(0);
    expect(removed.indexStatements).to.contain(RENAME_PRICE_REPLACEMENT);
  });

  it("leaves a hand-made index alone", () => {
    const actual = Existing(FULL_COLUMNS, [
      ...SignedIndexes(VEHICLES_PLAN),
      { name: "operator_hunch", valid: true },
      { name: "operator_broken", valid: false },
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE);
    expect(out.statements).to.deep.equal([]);
    expect(out.indexStatements).to.deep.equal([]);
  });

  it("drops obsolete indexes inside the transaction before a column retype", () => {
    const actual = Existing(RETYPED_COLUMNS, [
      ...OtherIndexes(VEHICLES_PLAN, "vehicles_tags"),
      DRIFTED_TAGS_INDEX,
    ]);
    const out = PlanTable(SCHEMA, VEHICLES_PLAN, actual, DESTRUCTIVE);
    expect(LastAt(out.statements, IsIndexDrop)).to.be.lessThan(
      FirstAt(out.statements, IsColumnChange),
    );
    expect(out.statements[0]).to.equal(
      `DROP INDEX IF EXISTS "shop"."vehicles_tags"`,
    );
    expect(out.indexStatements).to.have.lengthOf(2);
    expect(out.indexStatements[0]).to.match(
      /^CREATE INDEX CONCURRENTLY "vehicles_tags"/,
    );
  });

  it("emits nothing against the state its own creation produces", () => {
    const actual = Existing(
      CatalogColumns(VEHICLES_PLAN),
      SignedIndexes(VEHICLES_PLAN),
    );
    expect(PlanTable(SCHEMA, VEHICLES_PLAN, actual, SAFE)).to.deep.equal({
      statements: [],
      indexStatements: [],
      warnings: [],
    });
  });
});
