import { expect } from "chai";
import {
  CROSS_INSTANCE,
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Query } from "../connection";
import { Render } from "../implementations/database/relation";
import { ParseSchema } from "../implementations/database/fields";
import { SyncSchema } from "../implementations/database/migrate";
import { QuoteIdentifier } from "../implementations/database/sql";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { WaitForSchemaReady } from "../implementations/database/schema";
import { CompileExpression } from "../implementations/database/expression";
import {
  QualifiedName,
  SchemaName,
} from "../implementations/database/identifier";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";

interface Item {
  _id?: string;
  sku: string;
  price: number;
}

interface Tables {
  items: Item;
}

interface CompiledRead {
  sql: string;
  params: unknown[];
}

interface CatalogIndex {
  name: string;
  definition: string;
  signature: string | null;
  valid: boolean;
  unique: boolean;
}

const DEFINITION: SchemaDefinition = {
  items: {
    fields: { sku: "string", price: "number" },
    indexes: { sku: { crossInstance: true }, price: {} },
  },
};

const CATALOG_SQL = `
  SELECT c.relname AS name, pg_get_indexdef(c.oid) AS definition,
    obj_description(c.oid, 'pg_class') AS signature,
    i.indisvalid AS valid, i.indisunique AS "unique"
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND NOT i.indisprimary
  ORDER BY c.relname`;

const INSTANCES = ["alpha", "beta", "gamma"];
const ROWS_PER_INSTANCE = 2000;
const CONCURRENT_INITS = 3;

async function Catalog(schemaId: string): Promise<CatalogIndex[]> {
  const result = await Query<CatalogIndex>(CATALOG_SQL, [SchemaName(schemaId)]);
  return result.rows;
}

function Sync(schemaId: string): Promise<void> {
  return SyncSchema(schemaId, DEFINITION, ParseSchema(schemaId, DEFINITION));
}

async function Reset(schemaId: string): Promise<void> {
  const name = QuoteIdentifier(SchemaName(schemaId));
  await Query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
}

function Items(schemaId: string): string {
  return QualifiedName(SchemaName(schemaId), "items");
}

function CompileCrossInstanceGetAll(schema: Schema<Tables>): CompiledRead {
  const context = new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
  const stages = schema
    .instance(CROSS_INSTANCE)
    .table("items")
    .getAll("sku-42", "sku")
    .build();
  const root = BuildRoot(stages, context);
  const relation = ApplyStages(root.relation, root.rest, context);
  return { sql: Render(relation), params: context.params.all() };
}

describe("instance-aware secondary indexes", () => {
  it("builds the prefixed index and, for crossInstance, its unprefixed __g twin", async () => {
    const schemaId = "indexes_cross_instance";
    await Reset(schemaId);
    await Sync(schemaId);
    const indexes = await Catalog(schemaId);
    expect(indexes.map((index) => index.name)).to.deep.equal([
      "items_price",
      "items_sku",
      "items_sku__g",
    ]);
    expect(indexes.every((index) => index.valid)).to.equal(true);
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get("items_sku")?.definition).to.contain("(_instance, sku)");
    expect(byName.get("items_sku__g")?.definition).to.contain("(sku)");
    expect(byName.get("items_price")?.definition).to.contain(
      "(_instance, price)",
    );
  });

  it("converges once when several connections initialize the schema at the same time", async () => {
    const schemaId = "indexes_concurrent_init";
    await Reset(schemaId);
    const inits = Array.from({ length: CONCURRENT_INITS }, () =>
      Sync(schemaId),
    );
    await Promise.all(inits);
    const indexes = await Catalog(schemaId);
    expect(indexes.map((index) => index.name)).to.deep.equal([
      "items_price",
      "items_sku",
      "items_sku__g",
    ]);
    expect(indexes.every((index) => index.valid)).to.equal(true);
    expect(indexes.every((index) => index.signature !== null)).to.equal(true);
  });

  it("drops and rebuilds an index a failed concurrent build left invalid", async () => {
    const schemaId = "indexes_invalid_repair";
    await Reset(schemaId);
    await Sync(schemaId);
    const table = Items(schemaId);
    const index = QualifiedName(SchemaName(schemaId), "items_sku");
    await Query(
      `INSERT INTO ${table} (_id, sku, price) VALUES ('a', 'dup', 1), ('b', 'dup', 2)`,
    );
    await Query(`DROP INDEX ${index}`);
    const failed = Query(
      `CREATE UNIQUE INDEX CONCURRENTLY "items_sku" ON ${table} (_instance, sku)`,
    );
    await failed.then(
      () => expect.fail("the unique build should have failed"),
      () => undefined,
    );
    const broken = (await Catalog(schemaId)).find(
      (index) => index.name === "items_sku",
    );
    expect(broken?.valid).to.equal(false);

    await Sync(schemaId);

    const repaired = (await Catalog(schemaId)).find(
      (index) => index.name === "items_sku",
    );
    expect(repaired?.valid).to.equal(true);
    expect(repaired?.unique).to.equal(false);
    expect(repaired?.signature).to.equal(
      `antelopejs:1:btree:"_instance","sku"`,
    );
  });

  it("serves a cross-instance equality on a crossInstance index from __g", async () => {
    const schemaId = "indexes_planner";
    await Reset(schemaId);
    const schema = new Schema<Tables>(schemaId, DEFINITION);
    await WaitForSchemaReady(schemaId);
    for (const instance of INSTANCES) {
      await schema.createInstance(instance);
      const rows = Array.from({ length: ROWS_PER_INSTANCE }, (_, n) => ({
        sku: `sku-${n}`,
        price: n,
      }));
      await schema.instance(instance).table("items").insert(rows);
    }
    await Query(`ANALYZE ${Items(schemaId)}`);
    const compiled = CompileCrossInstanceGetAll(schema);
    const plan = await Query(`EXPLAIN ${compiled.sql}`, compiled.params);
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).to.contain("items_sku__g");
  });
});
