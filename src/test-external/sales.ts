import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import assert from "node:assert";
import { Client, type QueryResultRow } from "pg";

import { Query } from "../connection";
import { WaitForSchemaReady } from "../implementations/database/schema";

const SALES = "sales";

/**
 * The fixture declared as a generator writes it from the catalog: native names, every key column a
 * field of its own, and `_id` on each relation that has a key.
 */
const SALES_DEFINITION: SchemaDefinition = {
  accounts: {
    fields: {
      _id: "string",
      id: "string",
      name: "string",
      email: "string",
      status: "string",
      revenue: "number",
      score: "number",
      created_at: "date",
      signed_on: "date",
      last_seen: "date",
      external_ref: "string",
      active: "boolean",
      big_counter: "string",
      meta: "object",
      tags: "string[]",
    },
    indexes: {},
  },
  contacts: {
    fields: {
      _id: "string",
      contact_id: "string",
      account_id: "string",
      first_name: "string",
      created_at: "date",
    },
    indexes: {},
  },
  order_lines: {
    fields: {
      _id: "string",
      order_id: "number",
      line_no: "number",
      sku: "string",
      qty: "number",
    },
    indexes: {},
  },
  events: {
    fields: { _id: "string", event_ref: "string", at: "date", msg: "string" },
    indexes: {},
  },
  raw_log: { fields: { at: "date", msg: "string" }, indexes: {} },
  flags: {
    fields: { _id: "string", id: "number", ref: "string", n: "number" },
    indexes: {},
  },
  big_accounts: {
    fields: { id: "string", account_name: "string", revenue: "number" },
    indexes: {},
  },
  daily_signups: { fields: { day: "date", n: "number" }, indexes: {} },
  w_accounts: {
    fields: {
      _id: "string",
      id: "string",
      code: "string",
      email: "string",
      status: "string",
      revenue: "number",
      big: "number",
      rating: "number",
      seen: "date",
      at: "date",
      raw: "object",
      tags: "string[]",
      upper_code: "string",
    },
    indexes: {},
  },
  w_items: {
    fields: {
      _id: "string",
      sku: "string",
      account_id: "string",
      qty: "number",
    },
    indexes: {},
  },
  w_serial: {
    fields: { _id: "string", id: "number", label: "string" },
    indexes: {},
  },
  w_events: {
    fields: { _id: "string", at: "date", msg: "string" },
    indexes: {},
  },
  w_big: {
    fields: { _id: "string", id: "number", label: "string" },
    indexes: {},
  },
  w_lines: {
    fields: {
      _id: "string",
      order_id: "number",
      line_no: "number",
      qty: "number",
    },
    indexes: {},
  },
};

type SalesScalar = string | number | boolean | Date | null;

type SalesValue = SalesScalar | SalesScalar[] | Record<string, SalesScalar>;

export type SalesRow = { _id?: string } & Record<string, SalesValue>;

/** Registers the declaration and waits for it, as a generated module's startup does. */
export type SalesTables = Record<string, SalesRow>;

export async function RegisterSales(): Promise<Schema<SalesTables>> {
  const schema = new Schema<SalesTables>(SALES, SALES_DEFINITION);
  await WaitForSchemaReady(SALES);
  return schema;
}

/** The answer a native query over the same rows gives, which is what every read is held to. */
export async function Native<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await Query<T>(sql, params)).rows;
}

/**
 * How long the owner waits for its lock: it is granted at once unless another session is reading the
 * relation, and then the test fails on that rather than queueing every later reader behind it.
 */
const OWNER_LOCK_TIMEOUT_MS = 1000;

/**
 * Runs `body` while the fixture's owner holds `relation` in `ACCESS EXCLUSIVE` mode on a connection
 * of its own, so every read of it made inside `body` waits until `body` has settled.
 */
export async function WhileLocked<T>(
  relation: string,
  body: () => Promise<T>,
): Promise<T> {
  const url = process.env.PG_TEST_CLIENT_OWNER_URL;
  assert(url, "the external test setup exports the fixture owner's URL");
  const owner = new Client({ connectionString: url });
  await owner.connect();
  try {
    await owner.query("BEGIN");
    await owner.query(`SET LOCAL lock_timeout = ${OWNER_LOCK_TIMEOUT_MS}`);
    await owner.query(`LOCK TABLE ${relation} IN ACCESS EXCLUSIVE MODE`);
    return await body();
  } finally {
    await owner.query("ROLLBACK");
    await owner.end();
  }
}

export async function NativeCount(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = await Native<{ count: string }>(sql, params);
  return Number(rows[0].count);
}
