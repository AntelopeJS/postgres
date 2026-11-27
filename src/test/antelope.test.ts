import { Client } from "pg";
import { defineConfig } from "@antelopejs/interface-core/config";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

import {
  CLIENT_DATABASE,
  FIXTURE,
  READER_PASSWORD,
  CLIENT_ROLE,
  ReaderGrants,
  WriterGrants,
} from "../test-external/fixture";

const POSTGRES_IMAGE = "postgres:18-alpine";
const TEST_DATABASE = "antelopejs_test";
const EXTERNAL_MODE = "external";

let container: StartedPostgreSqlContainer | undefined;

const CENTRAL_DATABASE = "antelopejs_central";
const INSTANCE_DATABASE_PREFIX = "antelopejs_tenant_";
const INSTANCE_IDS: readonly string[] = ["alpha", "beta"];
const DRIFTED_INSTANCE_ID = "drifted";

interface InstanceSettings {
  database: string;
  list: { database: string; query: string };
  maxOpenPools: number;
}

interface ModuleSettings {
  url: string;
  mode?: string;
  catalog?: CatalogSettings;
  instanceDatabases?: InstanceSettings;
}

interface CatalogSettings {
  enabled: boolean;
}

function moduleConfig(config: ModuleSettings) {
  return { modules: { local: { config } } };
}

async function OwnerUrl(): Promise<string> {
  if (process.env.PG_TEST_URL) {
    return process.env.PG_TEST_URL;
  }
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEST_DATABASE)
    .start();
  return container.getConnectionUri();
}

async function Run(url: string, statements: readonly string[]) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

function WithDatabase(url: string, database: string, user?: string): string {
  const target = new URL(url);
  target.pathname = `/${database}`;
  if (user) {
    target.username = user;
    target.password = READER_PASSWORD;
  }
  return target.toString();
}

/**
 * Builds the client database as its owner would, and answers the URL of the SELECT-only account
 * the module is given: the database the external suite reads is one the adapter did not create.
 */
async function ClientDatabase(ownerUrl: string): Promise<string> {
  await Run(ownerUrl, [
    `DROP DATABASE IF EXISTS ${CLIENT_DATABASE}`,
    `CREATE DATABASE ${CLIENT_DATABASE}`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CLIENT_ROLE}') THEN
         CREATE ROLE ${CLIENT_ROLE} LOGIN PASSWORD '${READER_PASSWORD}';
       END IF;
     END $$`,
  ]);
  const clientOwnerUrl = WithDatabase(ownerUrl, CLIENT_DATABASE);
  await Run(clientOwnerUrl, [
    ...FIXTURE,
    ...ReaderGrants(CLIENT_ROLE),
    ...WriterGrants(CLIENT_ROLE),
  ]);
  process.env.PG_TEST_CLIENT_OWNER_URL = clientOwnerUrl;
  return WithDatabase(ownerUrl, CLIENT_DATABASE, CLIENT_ROLE);
}

/**
 * One database per instance beside the client's, each holding the same fixture with a few rows
 * marked with its id, and a central database whose table lists the instances.
 */
async function InstanceDatabases(ownerUrl: string): Promise<InstanceSettings> {
  await Run(ownerUrl, [
    `DROP DATABASE IF EXISTS ${CENTRAL_DATABASE}`,
    `CREATE DATABASE ${CENTRAL_DATABASE}`,
  ]);
  await Run(WithDatabase(ownerUrl, CENTRAL_DATABASE), [
    "CREATE TABLE tenants (id text PRIMARY KEY)",
    ...[...INSTANCE_IDS, DRIFTED_INSTANCE_ID].map(
      (id) => `INSERT INTO tenants VALUES ('${id}')`,
    ),
    `GRANT SELECT ON tenants TO ${CLIENT_ROLE}`,
  ]);
  const drifted = `${INSTANCE_DATABASE_PREFIX}${DRIFTED_INSTANCE_ID}`;
  await Run(ownerUrl, [
    `DROP DATABASE IF EXISTS ${drifted}`,
    `CREATE DATABASE ${drifted}`,
  ]);
  await Run(WithDatabase(ownerUrl, drifted), [
    ...FIXTURE,
    ...ReaderGrants(CLIENT_ROLE),
    ...WriterGrants(CLIENT_ROLE),
    "ALTER TABLE sales.flags DROP COLUMN n",
    "ALTER TABLE sales.w_serial ALTER COLUMN label TYPE varchar(40)",
    "DROP TABLE sales.raw_log",
  ]);
  for (const [index, id] of INSTANCE_IDS.entries()) {
    const database = `${INSTANCE_DATABASE_PREFIX}${id}`;
    await Run(ownerUrl, [
      `DROP DATABASE IF EXISTS ${database}`,
      `CREATE DATABASE ${database}`,
    ]);
    await Run(WithDatabase(ownerUrl, database), [
      ...FIXTURE,
      ...ReaderGrants(CLIENT_ROLE),
      ...WriterGrants(CLIENT_ROLE),
      `UPDATE sales.accounts SET name = '${id} ' || name WHERE id <= 3`,
      `UPDATE sales.flags SET n = ${100 + index} WHERE id = 1`,
    ]);
  }
  return {
    database: `${INSTANCE_DATABASE_PREFIX}{instance}`,
    list: {
      database: CENTRAL_DATABASE,
      query: "SELECT id FROM tenants ORDER BY id",
    },
    maxOpenPools: 2,
  };
}

export default defineConfig({
  name: "postgres-test",
  cacheFolder: ".antelope/cache",
  modules: {
    local: {
      source: { type: "local", path: "." },
    },
  },
  test: {
    folder: "dist/test",
    async setup() {
      const url = await OwnerUrl();
      if (process.env.PG_TEST_MODE !== EXTERNAL_MODE) {
        return moduleConfig({ url });
      }
      const clientUrl = await ClientDatabase(url);
      if (process.env.PG_TEST_INSTANCES !== "1") {
        return moduleConfig({
          url: clientUrl,
          mode: EXTERNAL_MODE,
          catalog: { enabled: true },
        });
      }
      return moduleConfig({
        url: clientUrl,
        mode: EXTERNAL_MODE,
        catalog: { enabled: true },
        instanceDatabases: await InstanceDatabases(url),
      });
    },
    async cleanup() {
      await container?.stop();
    },
  },
});
