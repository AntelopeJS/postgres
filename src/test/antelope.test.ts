import { defineConfig } from "@antelopejs/interface-core/config";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

const POSTGRES_IMAGE = "postgres:18-alpine";
const TEST_DATABASE = "antelopejs_test";

let container: StartedPostgreSqlContainer | undefined;

function moduleConfig(url: string) {
  return { modules: { local: { config: { url } } } };
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
      if (process.env.PG_TEST_URL) {
        return moduleConfig(process.env.PG_TEST_URL);
      }
      container = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase(TEST_DATABASE)
        .start();
      return moduleConfig(container.getConnectionUri());
    },
    async cleanup() {
      await container?.stop();
    },
  },
});
