import type { JourneyContext } from "@antelopejs/tooling-configs/verify";

import { seed, server, urlOf, type ModuleConfig } from "./session.ts";

/** The client database an external instance reads, created by its owner and never by the module. */
export const CLIENT = "client";

/** The account the external instance connects as: it reads every table and writes `sales.accounts` only. */
export const READER = "verify_reader";

const CLIENT_SCHEMA = `CREATE SCHEMA sales;
CREATE TYPE sales.status AS ENUM ('lead', 'active', 'churned');
CREATE TABLE sales.accounts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name varchar(20) NOT NULL, status sales.status NOT NULL DEFAULT 'lead', score integer, created_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z');
COMMENT ON TABLE sales.accounts IS 'Customer accounts';
CREATE TABLE sales.audit (id integer PRIMARY KEY, note text);
CREATE VIEW sales.active_accounts AS SELECT name, score FROM sales.accounts WHERE status = 'active';
INSERT INTO sales.accounts (name, status, score) SELECT 'Account ' || g, (ARRAY['lead', 'active', 'churned'])[1 + g % 3]::sales.status, g % 4 FROM generate_series(1, 30) g;
INSERT INTO sales.audit VALUES (1, 'kept');
GRANT USAGE ON SCHEMA sales TO ${READER};
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${READER};
GRANT INSERT, UPDATE, DELETE ON sales.accounts TO ${READER};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA sales TO ${READER};
ANALYZE sales.accounts;`;

/** Creates the client database, its reader account and its `sales` schema with 30 accounts, as the database's owner. */
export async function seedClient(context: JourneyContext): Promise<void> {
  await seed(context, "create the client database", `CREATE DATABASE ${CLIENT}`);
  await seed(context, "create the reader account", `CREATE ROLE ${READER} LOGIN`);
  await seed(context, "create the client's tables, rows and grants", CLIENT_SCHEMA, CLIENT);
}

/** The config of an external instance on the client database as the reader account, with `extra` merged in. */
export function externalConfig(context: JourneyContext, extra: ModuleConfig = {}): ModuleConfig {
  return { mode: "external", url: urlOf(server(context), READER, CLIENT), ...extra };
}

/** The declaration of the client's `sales` schema, verbatim names. */
export const SALES = `new Schema("sales", {
  accounts: { fields: { _id: "string", id: "string", name: "string", status: "string", score: "number", created_at: "date" }, indexes: {} },
  audit: { fields: { _id: "string", id: "number", note: "string" }, indexes: {} },
  active_accounts: { fields: { name: "string", score: "number" }, indexes: {} },
})`;
