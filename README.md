# @antelopejs/postgres

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/postgres"><img alt="npm" src="https://img.shields.io/npm/v/@antelopejs/postgres?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/postgres?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://interfaces.antelopejs.com/docs/database"><img src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

The PostgreSQL backend of AntelopeJS: it runs the database interface's queries on PostgreSQL with the [`pg`](https://github.com/brianc/node-postgres) driver, mapping schema definitions onto real relational tables with native column types and indexes. It can also serve tables that already exist in a database it does not own.

## Interfaces

| Interface                                                                            | Documentation                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`@antelopejs/interface-database`](https://github.com/AntelopeJS/interface-database) | [Database](https://interfaces.antelopejs.com/docs/database) |

Schemas, tables, queries, change feeds and atomic mutations are documented on the database interface pages.

## Install

```bash
ajs project modules add @antelopejs/postgres
```

The command writes the module's default configuration: `postgres://postgres@localhost:5432/antelopejs`, with `migrations: "safe"`.

**Requires PostgreSQL 16 or later.** The adapter uses `pg_input_is_valid` so that a text or jsonb
value which is not a parseable date yields `null` instead of aborting the whole statement. It is
the only construct used above PostgreSQL 9.5.

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

| Key            | Description                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | `"owned"` (default) creates and converges the tables; `"external"` serves existing tables without changing them.                                              |
| `url`          | PostgreSQL connection string.                                                                                                                                 |
| `migrations`   | `"safe"` (default) only adds columns and indexes; `"destructive"` also alters and drops them. See [Schema convergence](./docs/storage.md#schema-convergence). |
| `schemaPrefix` | Prefix for generated PostgreSQL schema names, for several applications sharing one database.                                                                  |
| `pool`         | Optional [`pg.Pool`](https://node-postgres.com/apis/pool) options, merged over the URL.                                                                       |

Cursor, statement-timeout and change-feed tuning are in [docs/configuration.md](./docs/configuration.md).

## Quick start

In the module that stores data, add the database interface:

```bash
pnpm add @antelopejs/interface-database
```

Then follow the [database interface guide](https://framework.antelopejs.com/docs/guides/database) to declare a schema and query it. The same code runs on [`@antelopejs/mongodb`](https://github.com/AntelopeJS/mongodb) and [`@antelopejs/rethinkdb`](https://github.com/AntelopeJS/rethinkdb); [Behaviour worth knowing](./docs/behaviour.md) records where the backends differ.

## Storage layout

Unlike the document-store backends, this module treats schema field declarations as real
DDL: each AntelopeJS schema becomes a PostgreSQL schema, each table a real table, and each
declared scalar field a natively typed, natively indexable column. Queries compile to a single
SQL statement — filters become `WHERE` clauses, joins become `JOIN`s, and a `filter` or `orderBy`
over a declared field reaches its btree index.

- One PostgreSQL schema per AntelopeJS schema id
- Declared scalar fields become typed columns; objects, arrays and undeclared fields live in `jsonb`
- Schema instances are isolated by an `_instance` discriminator column
- Additive schema convergence, with destructive changes refused unless explicitly enabled
- Change feeds, as a durable log plus a pull-based reader

**Requires PostgreSQL 16 or later.** The adapter uses `pg_input_is_valid` so that a text or jsonb
value which is not a parseable date yields `null` instead of aborting the whole statement. It is
the only construct used above PostgreSQL 9.5.

## Documentation

- [Database](https://interfaces.antelopejs.com/docs/database): the `@antelopejs/interface-database` contract this module implements
- [Configuration](https://framework.antelopejs.com/docs/concepts/configuration): module sources, `config` blocks and config variables in `antelope.config.ts`

This repository documents what is specific to the PostgreSQL backend:

|                                                |                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Storage and schema](./docs/storage.md)        | What a registered schema becomes in the database, the field-type table, what reaches an index, and how registration converges                      |
| [Configuration](./docs/configuration.md)       | Every option `construct` accepts                                                                                                                   |
| [External mode](./docs/external-mode.md)       | Reading tables the module did not create, in a database it does not own                                                                            |
| [Change feeds](./docs/change-feeds.md)         | `changes()`, its ordering guarantee, its retention contract and its blind spots                                                                    |
| [Errors and refusals](./docs/errors.md)        | Everything the module refuses, with the message it refuses by                                                                                      |
| [Behaviour worth knowing](./docs/behaviour.md) | Things that answer rather than throw, where the answer may surprise you — including where this backend differs from the MongoDB and RethinkDB ones |

## Compatibility

| Package                          | Supported range  |
| -------------------------------- | ---------------- |
| `@antelopejs/interface-database` | `^0.1.8`         |
| `@antelopejs/interface-core`     | `>=0.1.1 <1.0.0` |

The module is developed and tested against `@antelopejs/core` `^1.14.0` on Node.js 22 and 24, with the `pg` driver `^8.22.0` and PostgreSQL 18.

## Contributing

**Node 22 or later is required to develop or test this module**, though the published module itself
runs on any version its `pg` dependency supports. The floor comes from `testcontainers`, a
devDependency whose bundled `undici` calls `worker_threads.markAsUncloneable`, absent from Node 20.

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm knip
pnpm test:unit      # fast loop: this repository's unit specs, no Docker
pnpm test           # unit specs, then the conformance and external-mode suites against PostgreSQL
```

`pnpm test` provisions PostgreSQL with Testcontainers, so it needs a Docker daemon. Besides this
repository's own tests, it runs the shared conformance suite of `@antelopejs/interface-database`,
discovered from `antelopeJs.implements`.

To test against an existing server instead of a container, set `PG_TEST_URL`. It must point to a
disposable instance: the external suite drops and recreates a fixture database and may create a role.

```bash
PG_TEST_URL=postgres://postgres:postgres@localhost:5432/antelopejs_test pnpm test
```

Read the [contribution guidelines](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE)
