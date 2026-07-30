# @antelopejs/postgres

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/postgres"><img alt="NPM version" src="https://img.shields.io/npm/v/@antelopejs/postgres.svg?style=for-the-badge&labelColor=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/postgres.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://antelopejs.com/modules/postgres"><img src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

A PostgreSQL module that implements the Database interface for AntelopeJS, mapping schema
definitions onto real relational tables with native column types and indexes.

## Installation

```bash
ajs project modules add @antelopejs/postgres
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
declared scalar field a natively typed, natively indexable column.

- One PostgreSQL schema per AntelopeJS schema id
- Declared scalar fields become typed columns; objects, arrays and undeclared fields live in `jsonb`
- Schema instances are isolated by an `_instance` discriminator column
- Additive schema convergence, with destructive changes refused unless explicitly enabled

## Configuration

```typescript
{
    url: "postgres://postgres@localhost:5432/antelopejs",  // PostgreSQL connection string
    migrations: "safe",                 // "safe" (default) or "destructive"
    schemaPrefix: "",                   // Prefix for generated PostgreSQL schema names
    cursorBatchSize: 100,               // Rows fetched per round trip when iterating
    cursorIdleTimeoutMs: 60000,         // Idle cursors are reclaimed after this delay
    statementTimeoutMs: undefined,      // Optional per-statement timeout
    pool: {                             // Optional pg.Pool options, merged over the URL
        max: 10,
        connectionTimeoutMillis: 30000,
        idleTimeoutMillis: 30000
    }
}
```

### Configuration Details

The module uses the `pg` driver and delegates pooling to `pg.Pool`:

- `url` is passed as `connectionString`; anything in `pool` is merged over it
- The pool is opened and verified during `construct`, so a bad configuration fails at
  startup rather than on the first query
- `migrations` controls how far schema registration may go:
  - `safe` (default): create missing schemas, tables, columns and indexes; refuse a declared
    type change or a removed field
  - `destructive`: additionally allow column type changes and column drops
- `schemaPrefix` is useful when several applications share one database

## Development

```bash
pnpm install
pnpm build
pnpm test          # provisions an ephemeral PostgreSQL via embedded-postgres
```

To test against an existing server instead, set `PG_TEST_URL`:

```bash
PG_TEST_URL=postgres://postgres:postgres@localhost:5432/antelopejs_test pnpm test
```

`pnpm test` is the full conformance run. No test cases live in this repo: the suite ships in
the interface package and is discovered automatically from `antelopeJs.implements`, so
building and booting the module is all that is needed to exercise it.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
