import { expect } from "chai";
import type { PoolClient } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import {
  CROSS_INSTANCE,
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../logger";
import { AcquireClient, Query } from "../connection";
import { Render } from "../implementations/database/relation";
import { ParseSchema } from "../implementations/database/fields";
import { QuoteIdentifier } from "../implementations/database/sql";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileExpression } from "../implementations/database/expression";
import {
  BuildIndexes,
  ConvergeTables,
} from "../implementations/database/migrate";
import {
  QualifiedName,
  SchemaName,
} from "../implementations/database/identifier";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import {
  WaitForIndexes,
  WaitForSchemaReady,
} from "../implementations/database/schema";

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
  oid: number;
}

interface Settling {
  isSettled: boolean;
  done: Promise<void>;
}

interface Reads {
  scoped: Item[];
  crossInstance: Item[];
  ordered: Item[];
}

type InstanceId = string | typeof CROSS_INSTANCE;

const FIELDS: SchemaDefinition["items"]["fields"] = {
  sku: "string",
  price: "number",
};

const DEFINITION: SchemaDefinition = {
  items: {
    fields: FIELDS,
    indexes: { sku: { crossInstance: true }, price: {} },
  },
};

const UNINDEXED: SchemaDefinition = {
  items: { fields: FIELDS, indexes: {} },
};

const WIDENED: SchemaDefinition = {
  items: {
    fields: FIELDS,
    indexes: {
      sku: { crossInstance: true },
      price: { fields: ["price", "sku"] },
    },
  },
};

const DECLARED_INDEXES = ["items_price", "items_sku", "items_sku__g"];

const CATALOG_SQL = `
  SELECT c.relname AS name, pg_get_indexdef(c.oid) AS definition,
    obj_description(c.oid, 'pg_class') AS signature,
    i.indisvalid AS valid, i.indisunique AS "unique", c.oid::int AS oid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND NOT i.indisprimary
  ORDER BY c.relname`;

const INSTANCES = ["alpha", "beta", "gamma"];
const SCOPED_INSTANCE = "beta";
const ROWS_PER_INSTANCE = 2000;
const SMALL_ROWS_PER_INSTANCE = 40;
const CONCURRENT_INITS = 3;
const LOOKED_UP_SKU = "sku-7";
const POLL_MS = 20;
const POLL_ATTEMPTS = 250;
const POPULATE_TIMEOUT_MS = 60_000;

async function Catalog(schemaId: string): Promise<CatalogIndex[]> {
  const result = await Query<CatalogIndex>(CATALOG_SQL, [SchemaName(schemaId)]);
  return result.rows;
}

async function CatalogIndexNamed(
  schemaId: string,
  name: string,
): Promise<CatalogIndex | undefined> {
  return (await Catalog(schemaId)).find((index) => index.name === name);
}

async function Sync(
  schemaId: string,
  definition: SchemaDefinition = DEFINITION,
): Promise<void> {
  const shape = ParseSchema(schemaId, definition);
  const plans = await ConvergeTables(schemaId, definition, shape);
  await BuildIndexes(schemaId, plans);
}

async function Reset(schemaId: string): Promise<void> {
  const name = QuoteIdentifier(SchemaName(schemaId));
  await Query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
}

function Items(schemaId: string): string {
  return QualifiedName(SchemaName(schemaId), "items");
}

function Track(promise: Promise<void>): Settling {
  const settling: Settling = { isSettled: false, done: promise };
  settling.done = promise.then(() => {
    settling.isSettled = true;
  });
  return settling;
}

async function WaitUntil(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (await condition()) {
      return;
    }
    await delay(POLL_MS);
  }
  expect.fail("the condition never held");
}

async function HoldWrites(schemaId: string): Promise<PoolClient> {
  const client = await AcquireClient();
  await client.query("BEGIN");
  await client.query(`LOCK TABLE ${Items(schemaId)} IN ROW EXCLUSIVE MODE`);
  return client;
}

async function ReleaseWrites(client: PoolClient): Promise<void> {
  await client.query("COMMIT");
  client.release();
}

async function Seed(schema: Schema<Tables>, rowsPerInstance: number) {
  for (const instance of INSTANCES) {
    await schema.createInstance(instance);
    const rows = Array.from({ length: rowsPerInstance }, (_, n) => ({
      _id: `${instance}-${n}`,
      sku: `sku-${n}`,
      price: n,
    }));
    await schema.instance(instance).table("items").insert(rows);
  }
}

function ById(left: Item, right: Item): number {
  return String(left._id).localeCompare(String(right._id));
}

function Lookup(schema: Schema<Tables>, instance: InstanceId) {
  return schema.instance(instance).table("items").getAll(LOOKED_UP_SKU, "sku");
}

async function ReadEverything(schema: Schema<Tables>): Promise<Reads> {
  const scoped = await Lookup(schema, SCOPED_INSTANCE);
  const crossInstance = await Lookup(schema, CROSS_INSTANCE);
  const ordered = await schema
    .instance(CROSS_INSTANCE)
    .table("items")
    .orderBy("price")
    .slice(0, INSTANCES.length);
  return {
    scoped: [...scoped].sort(ById),
    crossInstance: [...crossInstance].sort(ById),
    ordered: [...ordered].map((row) => ({ ...row, _id: undefined })),
  };
}

function Compile(schema: Schema<Tables>, instance: InstanceId): CompiledRead {
  const context = new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
  const stages = Lookup(schema, instance).build();
  const root = BuildRoot(stages, context);
  const relation = ApplyStages(root.relation, root.rest, context);
  return { sql: Render(relation), params: context.params.all() };
}

async function Explain(
  schema: Schema<Tables>,
  instance: InstanceId,
): Promise<string> {
  const compiled = Compile(schema, instance);
  const plan = await Query(`EXPLAIN ${compiled.sql}`, compiled.params);
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

async function Populated(schemaId: string): Promise<Schema<Tables>> {
  await Reset(schemaId);
  const schema = new Schema<Tables>(schemaId, DEFINITION);
  await WaitForIndexes(schemaId);
  await Seed(schema, ROWS_PER_INSTANCE);
  await Query(`ANALYZE ${Items(schemaId)}`);
  return schema;
}

async function CaptureWarnings(work: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = Logger.Warn.bind(Logger);
  Logger.Warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    Logger.Warn = original;
  }
  return warnings;
}

describe("instance-aware secondary indexes", () => {
  it("builds the prefixed index and, for crossInstance, its unprefixed __g twin", async () => {
    const schemaId = "indexes_cross_instance";
    await Reset(schemaId);
    await Sync(schemaId);
    const indexes = await Catalog(schemaId);
    expect(indexes.map((index) => index.name)).to.deep.equal(DECLARED_INDEXES);
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
    expect(indexes.map((index) => index.name)).to.deep.equal(DECLARED_INDEXES);
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
    const broken = await CatalogIndexNamed(schemaId, "items_sku");
    expect(broken?.valid).to.equal(false);

    await Sync(schemaId);

    const repaired = await CatalogIndexNamed(schemaId, "items_sku");
    expect(repaired?.valid).to.equal(true);
    expect(repaired?.unique).to.equal(false);
    expect(repaired?.signature).to.equal(
      `antelopejs:1:btree:"_instance","sku"`,
    );
  });

  it("builds a drifted index's replacement under __next and swaps it in", async () => {
    const schemaId = "indexes_replacement_swap";
    await Reset(schemaId);
    await Sync(schemaId);
    const before = await CatalogIndexNamed(schemaId, "items_price");

    await Sync(schemaId, WIDENED);

    const indexes = await Catalog(schemaId);
    expect(indexes.map((index) => index.name)).to.deep.equal(DECLARED_INDEXES);
    const after = indexes.find((index) => index.name === "items_price");
    expect(after?.oid).to.not.equal(before?.oid);
    expect(after?.valid).to.equal(true);
    expect(after?.definition).to.contain("(_instance, price, sku)");
    expect(after?.signature).to.equal(
      `antelopejs:1:btree:"_instance","price","sku"`,
    );
  });
});

describe("the background index phase", () => {
  it("answers queries while the index phase is still building, with the same rows as after", async () => {
    const schemaId = "indexes_background_phase";
    await Reset(schemaId);
    const bare = new Schema<Tables>(schemaId, UNINDEXED);
    await WaitForIndexes(schemaId);
    await Seed(bare, SMALL_ROWS_PER_INSTANCE);
    const writes = await HoldWrites(schemaId);

    const schema = new Schema<Tables>(schemaId, DEFINITION);
    await WaitForSchemaReady(schemaId);
    const indexing = Track(WaitForIndexes(schemaId));
    const during = await ReadEverything(schema);
    const pending = await CatalogIndexNamed(schemaId, "items_sku");
    expect(indexing.isSettled).to.equal(false);
    expect(pending?.valid ?? false).to.equal(false);

    await ReleaseWrites(writes);
    await indexing.done;
    const built = await Catalog(schemaId);
    expect(built.map((index) => index.name)).to.deep.equal(DECLARED_INDEXES);
    expect(built.every((index) => index.valid)).to.equal(true);
    expect(await ReadEverything(schema)).to.deep.equal(during);
    expect(during.crossInstance).to.have.lengthOf(INSTANCES.length);
  });

  it("does not make a second init wait for the builds of the first", async () => {
    const schemaId = "indexes_second_init";
    await Reset(schemaId);
    await Sync(schemaId, UNINDEXED);
    const writes = await HoldWrites(schemaId);
    const shape = ParseSchema(schemaId, DEFINITION);

    const plans = await ConvergeTables(schemaId, DEFINITION, shape);
    const first = Track(BuildIndexes(schemaId, plans));
    await WaitUntil(async () => (await Catalog(schemaId)).length > 0);
    await ConvergeTables(schemaId, DEFINITION, shape);
    await BuildIndexes(schemaId, plans);
    expect(first.isSettled).to.equal(false);

    await ReleaseWrites(writes);
    await first.done;
    const indexes = await Catalog(schemaId);
    expect(indexes.map((index) => index.name)).to.deep.equal(DECLARED_INDEXES);
    expect(indexes.every((index) => index.valid)).to.equal(true);
  });
});

describe("cross-instance reads of secondary indexes", () => {
  describe("on a populated table", () => {
    let schema: Schema<Tables>;

    before(async function () {
      this.timeout(POPULATE_TIMEOUT_MS);
      schema = await Populated("indexes_planner");
    });

    it("serves a cross-instance equality on a crossInstance index from __g", async () => {
      expect(await Explain(schema, CROSS_INSTANCE)).to.contain("items_sku__g");
    });

    it("returns the same rows scoped and cross-instance, the scoped read keeping the prefixed index", async () => {
      const scopedPlan = await Explain(schema, SCOPED_INSTANCE);
      expect(scopedPlan).to.match(/items_sku\b/);
      expect(scopedPlan).to.not.contain("items_sku__g");

      const crossInstance = await Lookup(schema, CROSS_INSTANCE);
      const perInstance = await Promise.all(
        INSTANCES.map((instance) => Lookup(schema, instance)),
      );
      expect([...crossInstance].sort(ById)).to.deep.equal(
        perInstance.flat().sort(ById),
      );
    });
  });

  it("warns once per schema, table and index a CROSS_INSTANCE scan does not serve", async () => {
    const schemaId = "indexes_scan_warning";
    await Reset(schemaId);
    const schema = new Schema<Tables>(schemaId, DEFINITION);
    await WaitForIndexes(schemaId);
    const crossInstance = schema.instance(CROSS_INSTANCE).table("items");
    const scoped = schema.instance(SCOPED_INSTANCE).table("items");

    const warnings = await CaptureWarnings(async () => {
      await crossInstance.getAll(1, "price");
      await crossInstance.getAll(2, "price");
      await crossInstance.orderBy("price");
      await crossInstance.getAll(LOOKED_UP_SKU, "sku");
      await crossInstance.getAll(LOOKED_UP_SKU, "undeclared");
      await scoped.getAll(1, "price");
    });

    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.contain(`'${schemaId}.items'`);
    expect(warnings[0]).to.contain("index 'price'");
  });
});
