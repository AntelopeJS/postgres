import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

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
};

/** Registers the declaration and waits for it, as a generated module's startup does. */
export type SalesTables = Record<string, Record<string, unknown>>;

export async function RegisterSales(): Promise<Schema<SalesTables>> {
  const schema = new Schema<SalesTables>(SALES, SALES_DEFINITION);
  await WaitForSchemaReady(SALES);
  return schema;
}

/** The answer a native query over the same rows gives, which is what every read is held to. */
export async function Native<T>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await Query(sql, params)).rows as T[];
}

export async function NativeCount(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = await Native<{ count: string }>(sql, params);
  return Number(rows[0].count);
}
