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

interface ModuleSettings {
  url: string;
  mode?: string;
  catalog?: CatalogSettings;
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
      return moduleConfig({
        url: await ClientDatabase(url),
        mode: EXTERNAL_MODE,
        catalog: { enabled: true },
      });
    },
    async cleanup() {
      await container?.stop();
    },
  },
});
