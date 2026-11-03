# `@antelopejs/postgres`

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/postgres"><img data-illustration alt="npm" src="https://img.shields.io/npm/v/@antelopejs/postgres?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img data-illustration alt="License" src="https://img.shields.io/npm/l/@antelopejs/postgres?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/g4pFt6eXqu"><img data-illustration src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://interfaces.antelopejs.com/docs/database"><img data-illustration src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

The PostgreSQL backend of AntelopeJS. It runs the queries of the database interface on PostgreSQL with the [`pg`](https://github.com/brianc/node-postgres) driver, and maps schema definitions onto relational tables with native column types and indexes. It can also serve tables that already exist in a database it does not own.

## Interfaces

| Interface                                                                            | Documentation                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`@antelopejs/interface-database`](https://github.com/AntelopeJS/interface-database) | [Database](https://interfaces.antelopejs.com/docs/database) |

The database interface pages document schemas, tables, queries, change feeds and atomic mutations.

## Install

```bash
ajs project modules add @antelopejs/postgres
```

The command writes the module's default configuration, the URL `postgres://postgres@localhost:5432/antelopejs` with `migrations: "safe"`.

The adapter calls PostgreSQL's `pg_input_is_valid` function, so that a text or jsonb value that is not a parseable date yields `null` and does not abort the whole statement. The server must provide that function. [`src/test/antelope.test.ts`](src/test/antelope.test.ts) names the PostgreSQL image that the tests run against.

## Configuration

```typescript [antelope.config.ts]
import { defineConfig } from "@antelopejs/interface-core/config";

export default defineConfig({
  name: "my-project",
  modules: {
    postgres: {
      source: {
        type: "package",
        package: "@antelopejs/postgres",
        version: "^0.2.0",
      },
      config: {
        url: "postgres://postgres@localhost:5432/my-project",
        migrations: "safe",
        pool: { max: 10 },
      },
    },
  },
  envOverrides: {
    POSTGRES_URL: "modules.postgres.config.url",
  },
});
```

| Key            | Description                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | `"owned"` (default) creates and converges the tables. `"external"` serves existing tables without changing them.                                                 |
| `url`          | PostgreSQL connection string.                                                                                                                                    |
| `migrations`   | `"safe"` (default) only adds columns and indexes. `"destructive"` also alters and drops columns. See [Schema convergence](./docs/storage.md#schema-convergence). |
| `schemaPrefix` | Prefix for generated PostgreSQL schema names, for several applications sharing one database.                                                                     |
| `pool`         | Optional [`pg.Pool`](https://node-postgres.com/apis/pool) options, merged over the URL.                                                                          |

[docs/configuration.md](./docs/configuration.md) lists the options for cursors, the statement timeout and change feeds.

## Quick start

In the module that stores data, add the database interface:

```bash
pnpm add @antelopejs/interface-database
```

Then follow the [database interface guide](https://framework.antelopejs.com/docs/guides/database) to declare a schema and query it. The same code runs on [`@antelopejs/mongodb`](https://github.com/AntelopeJS/mongodb) and [`@antelopejs/rethinkdb`](https://github.com/AntelopeJS/rethinkdb). [Behaviour worth knowing](./docs/behaviour.md) records where the backends differ.

## Storage layout

Unlike the document-store backends, this module turns schema field declarations into DDL. Each AntelopeJS schema becomes a PostgreSQL schema, each table a real table, and each declared scalar field a column with a native type and native indexes. A query compiles to a single SQL statement. Filters become `WHERE` clauses, joins become `JOIN`s, and a `filter` or `orderBy` over a declared field reaches its btree index.

- One PostgreSQL schema per AntelopeJS schema id.
- Declared scalar fields become typed columns. Objects, arrays and undeclared fields live in `jsonb`.
- An `_instance` discriminator column keeps schema instances apart.
- Schema convergence only adds, and refuses destructive changes unless you turn them on.
- Change feeds are a durable log plus a pull-based reader.

## Documentation

- [Database](https://interfaces.antelopejs.com/docs/database) is the `@antelopejs/interface-database` contract that this module implements.
- [Configuration](https://framework.antelopejs.com/docs/concepts/configuration) covers module sources, `config` blocks and config variables in `antelope.config.ts`.

This repository documents what is specific to the PostgreSQL backend:

|                                                |                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Storage and schema](./docs/storage.md)        | What a registered schema becomes in the database, the field-type table, what reaches an index, and how registration converges                     |
| [Configuration](./docs/configuration.md)       | Every option `construct` accepts                                                                                                                  |
| [External mode](./docs/external-mode.md)       | Reading tables the module did not create, in a database it does not own                                                                           |
| [Change feeds](./docs/change-feeds.md)         | `changes()`, its ordering guarantee, its retention contract and its blind spots                                                                   |
| [Errors and refusals](./docs/errors.md)        | Everything the module refuses, with the message it refuses by                                                                                     |
| [Behaviour worth knowing](./docs/behaviour.md) | Things that answer rather than throw, where the answer may surprise you, including where this backend differs from the MongoDB and RethinkDB ones |

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package                                  | Supported                                                      | Tested with                                                    |
| ---------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `@antelopejs/interface-core`             | `>=0.1.1 <1.0.0`                                               | `0.2.0`                                                        |
| `@antelopejs/interface-database`         | `file:.campaign/tgz/antelopejs-interface-database-724ff72.tgz` | `file:.campaign/tgz/antelopejs-interface-database-724ff72.tgz` |
| `@antelopejs/interface-database-catalog` | `>=0.0.3 <0.1.0`                                               | `0.0.3`                                                        |

<!-- antelopejs-docs-compat:end -->

CI tests every Node.js major listed under `node-versions` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), and [`.nvmrc`](.nvmrc) names the version for local work. The `dependencies` field of [`package.json`](package.json) sets the `pg` driver range, and [`src/test/antelope.test.ts`](src/test/antelope.test.ts) names the PostgreSQL image that the tests run against.

## Contributing

The `engines` field of [`package.json`](package.json) sets the Node.js floor. The floor comes from Testcontainers, a dev dependency whose bundled `undici` calls `worker_threads.markAsUncloneable`, which older Node.js majors lack.

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm knip
pnpm test:unit      # fast loop: this repository's unit specs, no Docker
pnpm test           # everything, against PostgreSQL: unit specs, conformance and external-mode suites
```

`pnpm test` starts PostgreSQL with Testcontainers, so it needs a Docker daemon. Besides this repository's own tests, it runs the shared conformance suites of the interfaces listed in `antelopeJs.implements`.

To test against an existing server instead of a container, set `PG_TEST_URL`. It must point to a disposable instance, because the external suite drops and recreates a fixture database and may create a role.

```bash
PG_TEST_URL=postgres://postgres:postgres@localhost:5432/antelopejs_test pnpm test
```

Read the [contribution guidelines](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE)
