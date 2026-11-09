import type { VerifyConfig } from "@antelopejs/tooling-configs/verify";

import { catalogDescribe, catalogRefused } from "./journeys-catalog.ts";
import { externalReadWrite, externalRegistration } from "./journeys-external.ts";
import { changeFeeds } from "./journeys-feeds.ts";
import { configOptions, configRefused } from "./journeys-module.ts";
import { readQueries } from "./journeys-reads.ts";
import { migrations, storageLayout } from "./journeys-schemas.ts";
import { insertValues, updateReplaceDelete } from "./journeys-writes.ts";
import { DATABASE, ownedConfig, SERVICE } from "./session.ts";

const ADMIN = ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qc"];

const config: VerifyConfig = {
  doors: {
    data: {
      globs: [
        "src/implementations/database/ddl.ts",
        "src/implementations/database/migrate.ts",
        "src/implementations/database/convergence.ts",
        "src/implementations/database/instances.ts",
        "src/implementations/database/writes*.ts",
        "src/implementations/database/external-writes.ts",
        "src/implementations/database/changes.ts",
        "src/implementations/database/reaper.ts",
      ],
      funnels: [
        "src/implementations/database/ddl.ts",
        "src/implementations/database/migrate.ts",
        "src/implementations/database/writes.ts",
        "src/implementations/database/external-writes.ts",
      ],
      why: "these modules run the DDL that converges a schema (a destructive migration drops or retypes columns), write and delete rows, wipe an instance and trim the change log: a change here can lose stored rows or write into a client's external database",
    },
    format: {
      globs: [
        "src/implementations/database/schema.ts",
        "src/implementations/database/identifier.ts",
        "src/implementations/database/types.ts",
        "src/implementations/database/jsonb.ts",
        "src/implementations/database/value.ts",
        "src/implementations/database/coerce.ts",
        "src/implementations/database/utils.ts",
        "src/implementations/database/changes.ts",
      ],
      funnels: [],
      why: "the `__antelope.changes` log and the triggers a watched table keeps, the PostgreSQL schema per schema id, the column names and their 63-byte truncation, the field-type to column-type table, the _id, _instance and _extra columns, the `__antelope` bookkeeping schema and the index names and comments are the layout every stored table already has: an upgrade that changes them stops finding what the last release wrote",
    },
    contract: {
      globs: ["package.json", "src/config.ts", "src/index.ts"],
      funnels: [],
      why: "the config keys (`mode`, `url`, `pool`, `schemaPrefix`, `migrations`, the cursor and change options, `catalog`), `antelopeJs.defaultConfig` and the implemented interfaces",
    },
    outbound: null,
    exposure: null,
    publish: {
      globs: ["package.json", ".release-it.json", "changelogen.config.json", ".github/workflows/release.yml"],
      funnels: [],
      why: "the package name and release workflow claim @antelopejs/postgres on npm",
    },
  },
  userFacing: ["src/*.ts", "src/implementations/**"],
  services: {
    [SERVICE]: {
      image: "postgres:18-alpine",
      port: 5432,
      env: { POSTGRES_HOST_AUTH_METHOD: "trust", POSTGRES_DB: DATABASE },
      ready: ["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", DATABASE, "-tAc", "SELECT 1"],
      reset: [
        "sh",
        "-c",
        [
          `${ADMIN.join(" ")} 'DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)'`,
          `${ADMIN.join(" ")} 'DROP DATABASE IF EXISTS client WITH (FORCE)'`,
          `${ADMIN.join(" ")} 'DROP ROLE IF EXISTS verify_reader'`,
          `${ADMIN.join(" ")} 'CREATE DATABASE ${DATABASE}'`,
        ].join(" && "),
      ],
    },
  },
  moduleConfig(services) {
    const found = services.find((service) => service.name === SERVICE);
    return ownedConfig({ name: SERVICE, container: found?.container ?? "", host: found?.host ?? "127.0.0.1", port: found?.port ?? 5432 });
  },
  journeys: {
    "config-refused": configRefused,
    "config-options": configOptions,
    "storage-layout": storageLayout,
    migrations,
    "insert-values": insertValues,
    "update-replace-delete": updateReplaceDelete,
    "read-queries": readQueries,
    "change-feeds": changeFeeds,
    "external-read-write": externalReadWrite,
    "external-registration": externalRegistration,
    "catalog-describe": catalogDescribe,
    "catalog-refused": catalogRefused,
  },
};

export default config;
