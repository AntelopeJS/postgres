# @antelopejs-private/postgres

<div align="center">
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge&labelColor=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://antelopejs.com/modules/postgres"><img src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

A PostgreSQL module that implements the Database interface for AntelopeJS, mapping schema
definitions onto real relational tables with native column types and indexes.

## Installation

Configure the private registry in your project's `.npmrc` and authenticate with an AntelopeJS registry token:

```ini
@antelopejs-private:registry=https://npm.antelopejs.cloud/
//npm.antelopejs.cloud/:_authToken=${NPM_ANTELOPE_TOKEN}
```

Set `NPM_ANTELOPE_TOKEN` in your environment, then install the module:

```bash
ajs project modules add @antelopejs-private/postgres
```

## Interfaces

This module implements the Database interface, which provides a standardized database
abstraction layer. The interface is installed separately to maintain modularity and minimize
dependencies.

| Name     | Install command                   |                                                                   |
| -------- | --------------------------------- | ----------------------------------------------------------------- |
| Database | `ajs module imports add database` | [Documentation](https://github.com/AntelopeJS/interface-database) |

## Overview

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

## Configuration

```typescript
{
    url: "postgres://postgres@localhost:5432/antelopejs",  // PostgreSQL connection string
    migrations: "safe",                 // "safe" (default) or "destructive"
    schemaPrefix: "",                   // Prefix for generated PostgreSQL schema names
    pool: { max: 10 }                   // Optional pg.Pool options, merged over the URL
}
```

Cursor and change-feed tuning, and what each option does, is in
[docs/configuration.md](./docs/configuration.md).

## Documentation

|                                                |                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Storage and schema](./docs/storage.md)        | What a registered schema becomes in the database, the field-type table, what reaches an index, and how registration converges                      |
| [Configuration](./docs/configuration.md)       | Every option `construct` accepts                                                                                                                   |
| [Change feeds](./docs/change-feeds.md)         | `changes()`, its ordering guarantee, its retention contract and its blind spots                                                                    |
| [Errors and refusals](./docs/errors.md)        | Everything the module refuses, with the message it refuses by                                                                                      |
| [Behaviour worth knowing](./docs/behaviour.md) | Things that answer rather than throw, where the answer may surprise you — including where this backend differs from the MongoDB and RethinkDB ones |

## Development

**Node 22 or later is required to develop or test this module**, though the published module itself
runs on any version its `pg` dependency supports. The floor comes from `testcontainers`, a
devDependency whose bundled `undici` calls `worker_threads.markAsUncloneable`, absent from Node 20.

```bash
pnpm install
pnpm build
pnpm run test:unit   # fast loop: this repo's own specs, no Docker
pnpm test            # full conformance run, provisions PostgreSQL via testcontainers
```

To test against an existing server instead of a container, set `PG_TEST_URL`:

```bash
PG_TEST_URL=postgres://postgres:postgres@localhost:5432/antelopejs_test pnpm test
```

`pnpm test` needs a Docker daemon. No test cases live in this repo: the suite ships in the interface
package and is discovered automatically from `antelopeJs.implements`, so building and booting the
module is all that is needed to exercise it.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
