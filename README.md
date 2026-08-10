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
declared scalar field a natively typed, natively indexable column. Queries compile to a single
SQL statement — filters become `WHERE` clauses, joins become `JOIN`s, and a `filter` or `orderBy`
over a declared field reaches its btree index.

- One PostgreSQL schema per AntelopeJS schema id
- Declared scalar fields become typed columns; objects, arrays and undeclared fields live in `jsonb`
- Schema instances are isolated by an `_instance` discriminator column
- Additive schema convergence, with destructive changes refused unless explicitly enabled

**Requires PostgreSQL 16 or later.** The adapter uses `pg_input_is_valid` so that a text or jsonb
value which is not a parseable date yields `null` instead of aborting the whole statement. It is
the only construct used above PostgreSQL 9.5.

**Change feeds are not implemented.** `table.changes()` always throws
`Change feeds are not supported by the PostgreSQL backend`. See
[Not supported](#not-supported) below.

## Storage layout

A registered schema produces ordinary tables you can inspect and query directly:

```sql
CREATE SCHEMA "test-lookup-operations";
CREATE TABLE "test-lookup-operations".orders (
  _id           text  NOT NULL,
  _instance     text  NOT NULL DEFAULT '',
  "orderId"     text,
  "orderDate"   timestamptz,
  "totalAmount" double precision,
  "isPaid"      boolean,
  "items"       jsonb,                      -- declared "object[]"
  "metadata"    jsonb,                      -- declared nested record
  _extra        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (_instance, _id)
);
```

- **One PostgreSQL schema per AntelopeJS schema id**, table name = interface table name. No name
  mangling. Use `schemaPrefix` when several applications share one database.
- **`_id` is `text`**, not `uuid` — callers supply arbitrary strings like `"user-123"`. It is
  generated with `node:crypto.randomUUID` when absent, before the statement runs, which is what
  makes `insert` able to return the keys it created without reading anything back.
- **`_instance` is the instance discriminator**, defaulting to `''` for the unnamed instance, and it
  is the *leading* column of the primary key — so `WHERE _instance = $1` is served by the primary
  key with no extra index, and `CROSS_INSTANCE` is simply the absence of that predicate.
- **`_extra jsonb` absorbs undeclared fields.** Writing a field your schema does not declare is
  allowed and round-trips; it just lives in `_extra` rather than in a column of its own, with the
  consequences listed under [Behaviour worth knowing](#behaviour-worth-knowing).
- **`_id`, `_instance` and `_extra` are reserved.** Declaring any of them as a field is an error at
  registration, and naming `_instance` or `_extra` in a write payload is an error at query time.
- **Instances are tracked in a `__antelope` schema**, in
  `instances(schema_id, instance_id, created_at)`. `destroyInstance` deletes rows and never drops a
  schema or a table, as a single statement so a partial destroy cannot leave an instance half-wiped.

Identifiers longer than PostgreSQL's 63-byte limit are truncated to 55 bytes plus a hash suffix.
Registration refuses a collision loudly rather than letting two fields share a column, so a column
name is not always the field name verbatim.

## Field types

The accepted token set is closed and **case-insensitive** — `"date"` and `"Date"` both work.

| Declared | Column type | Notes |
| --- | --- | --- |
| `string` | `text` | |
| `number` | `double precision` | JS numbers *are* float64, so this is exact rather than a compromise |
| `boolean` | `boolean` | |
| `date` | `timestamptz` | read back as a `Date` |
| `object` / `any` | `jsonb` | no declared shape |
| nested record, e.g. `{ a: "number" }` | `jsonb` | shape is remembered for type inference |
| `"string[]"` or `["string"]` | `jsonb` | see below |
| io-ts codec at the field root | `jsonb` | **the codec is recorded and never invoked** — the field behaves as a plain shapeless `jsonb` column |
| anything else | — | error at registration, naming the field |

**Arrays map to `jsonb`, not to native `text[]`.** jsonb's `->` is 0-based, which matches the
interface's array indexing; `jsonb_array_elements` handles nested and heterogeneous arrays
uniformly; and `@>` containment stays GIN-indexable.

## Indexes

A declared index becomes a real index, and the operations that can use one do:

- **Secondary btree indexes lead with `_instance`**, because every non-`CROSS_INSTANCE` read carries
  `WHERE _instance = $1`. An index on `("_instance", "price")` serves
  `_instance = '' AND price > 1000` as one range scan.
- **`multi` maps to GIN** over a single jsonb-backed field, making `@>`, `?`, `?|` and `?&`
  index-reachable. A GIN index is keyed on the column alone, with no leading `_instance`. `multi` on
  a scalar field falls back to btree rather than erroring.
- **What reaches an index:** `filter` and `orderBy` on a declared field, `get`, `getAll`, `between`,
  a `joinInner` predicate, and a `lookup`'s local key.

Declaring a field is therefore the single most useful thing you can do for query performance: an
undeclared key lives in `_extra`, where there is no declared type to compare by and no index to
serve it.

## Schema convergence

Registration reconciles the declared schema against what is actually in the database.

| Change | `safe` (default) | `destructive` |
| --- | --- | --- |
| New declared field | `ADD COLUMN` | `ADD COLUMN` |
| Declared type differs from the column | **error naming the field** | `ALTER COLUMN … TYPE` |
| Column exists, no longer declared | warning, column kept | `DROP COLUMN` |
| Index missing | `CREATE INDEX` | same |
| Index definition changed | `DROP` + `CREATE` | same |
| Adapter-owned index no longer declared | `DROP INDEX` | same |
| Index this adapter did not create | left alone | left alone |

A type mismatch is fatal under `safe` because it is otherwise a *query-time* failure, silent until
the first read. Dropping an index loses no data, which is why the index rows need no opt-in.

**A newly added column is backfilled out of `_extra` in the same transaction.** Adding a field to a
schema that already has rows moves the existing values from the overflow document into the new
column, so a row does not go on displaying a value that `filter` can no longer find.

Each schema converges in one transaction, and adapter-owned indexes are recognised by a signature
stored as the index comment rather than by parsing the index definition back.

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

### Configuration details

The module uses the `pg` driver and delegates pooling to `pg.Pool`:

- `url` is passed as `connectionString`; anything in `pool` is merged over it
- The pool is opened and verified during `construct`, so a bad configuration fails at startup
  rather than on the first query
- Every pooled connection is pinned to `TimeZone = 'UTC'` and `DateStyle = 'ISO, MDY'`, so that a
  stored text value read as a date resolves the same way regardless of server settings
- `statementTimeoutMs` becomes the connection's `statement_timeout`. Schema convergence deliberately
  runs with it disabled, since one `CREATE INDEX` can legitimately outlast a per-query budget
- `migrations` controls how far registration may go — see
  [Schema convergence](#schema-convergence)
- `schemaPrefix` is useful when several applications share one database
- `cursorBatchSize` and `cursorIdleTimeoutMs` are **refused unless they are positive safe integers**,
  where every other numeric option is taken as given. `FETCH` will not accept a bound parameter for
  its count, so `cursorBatchSize` is the one configured value that reaches SQL as text rather than
  as a parameter, and it is validated at `construct()` for that reason

## Not supported

Each of these throws with the message shown. Placeholders in `{braces}` are filled in from what you
passed.

### Change feeds

```
Change feeds are not supported by the PostgreSQL backend
```

`table.changes()` and anything that iterates it. This is the one interface method this module does
not implement; it is planned rather than declined.

### Declaring a schema

| What you did | Message |
| --- | --- |
| Declared `_id`, `_instance` or `_extra` as a field | `Field '{name}' on '{table}' uses a reserved column name (_id, _instance, _extra)` |
| Used an unrecognised type token | `Unsupported field type '{token}' for '{path}'. Supported: string, number, boolean, date, object, any, optionally suffixed with [], a nested record, or an io-ts codec` |
| Declared an array with more than one element type | `Field '{path}' must declare exactly one element type, received {n}` |
| Two fields that truncate to the same column name | `Fields '{a}' and '{b}' on '{table}' both map to column '{column}'; rename one` |
| Two tables or indexes that truncate to the same name | `The physical name '{name}' is claimed by both {a} and {b}; rename one` |
| Indexed a reserved column | `Index '{indexId}' keys on '{field}', which is a reserved column the adapter owns; index a declared field instead` |
| Changed a declared type under `migrations: "safe"` | `Column '{name}' on {table} is {actual} but the schema declares {declared}; set migrations: "destructive" to alter it` |
| Pointed the adapter at a pre-existing table it did not create | `Table {target} has no '{column}' column and one cannot be added without a default, so the table was not created by this adapter; rename it or drop it` |

### Selecting rows

| What you did | Message |
| --- | --- |
| Named an index that does not exist | `Unknown index '{indexId}' on '{schema}.{table}'` |
| `between` on a compound index | `The 'between' stage ranges over one field, but '{name}' names {n}` |
| `between` on a field declared as an array | `The 'between' stage ranges over one value, but '{name}' holds a list` |
| `getAll` key of the wrong arity for a compound index | `The '{indexId}' index takes a key of {n} values, received {m}` |
| Used an index that keys on an array field alongside others | `The '{indexId}' index keys on an array field beside others, which no key addresses` |
| `lookup` on a local key the schema does not declare | `The 'lookup' stage takes its form from the local key's declared type, and '{key}' has none; …` |

`lookup` needs the declared type because it decides statically whether the key is a scalar or a
list. An undeclared key has no type to read, and guessing from the stored value would silently
overwrite an array with a single miss.

### Writing

| What you did | Message |
| --- | --- |
| `insert` after any pipeline stage | `The 'insert' stage does not read the rows it is applied to, so every stage before it would be discarded: {stages}` |
| A write after a reshaping stage, e.g. `table.map(…).delete()` | `A row-mode relation must carry the origin of its table` |
| Named `_instance` or `_extra` in a payload | `Payload key '{name}' is a column this adapter owns and no payload may write it` |
| `update({})` | `The '{stage}' stage was given a payload with nothing to write: name a field to set, or set one to undefined to remove it` |
| Named `_id` in a payload over many rows | `The '{stage}' stage was given a payload naming '_id' over a selection of many rows: address the row with get(_id) first, or leave '_id' out of the payload` |
| A mapper that returned nothing | `The '{stage}' stage was given a mapper that returned nothing: return the document the rows become` |
| Wrote a non-boolean into a declared `boolean` column | `{subject} takes a boolean or a json boolean for a boolean column, received {type}` |
| `insert` or `replace` under `CROSS_INSTANCE` | `The '{stage}' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one` |
| A write nested inside another query | `The '{stage}' stage writes, so it cannot be nested inside another query` |
| A write read through a cursor | `The '{stage}' stage writes, so it cannot be read through a cursor` |

`replace({})` is *not* refused: it names every column it did not name, so it is a well-formed
statement that empties the row. `update({})` writes nothing at all.

Naming `_id` in an `update` or `replace` payload is allowed over a single row, where it acts as an
assertion that the row you addressed carries that key.

### Grouping

| What you did | Message |
| --- | --- |
| `filter`, `orderBy`, `slice`, `nth`, `join`, `lookup`, `union` or a nested `group` inside a `group` callback | `The '{stage}' stage cannot appear in a group's sub-stream, though it is legal on the query outside the group` |
| Two aggregates in one sub-stream, e.g. `stream.count().count()` | `The '{stage}' stage cannot follow an aggregate in a group's sub-stream, since an aggregate may not read another one` |

A group's callback accepts `map`, `distinct`, `count`, `sum`, `avg`, `min` and `max`.

### Instances and configuration

| What you did | Message |
| --- | --- |
| Passed `CROSS_INSTANCE` to `createInstance` / `destroyInstance` | `{operation} does not accept CROSS_INSTANCE: pass a string id or omit it for the default instance` |
| Passed a non-string instance id | `{operation} expects a string instance id, received {type}` |
| A `cursorBatchSize` or `cursorIdleTimeoutMs` that is not a positive safe integer | `{option} must be a positive safe integer, received {value}` |

## Behaviour worth knowing

Things that answer rather than throw, where the answer may not be the one you expected.

| Behaviour | Detail |
| --- | --- |
| `getAll` cannot address a single array-valued key | An array at the top level is always read as a *key list*, since the interface supplies no marker distinguishing the two. Both other backends read it the same way |
| `lookup`'s array form does not preserve the local key's order | The elements come back in the joined table's scan order, so `["B","A"]` and `["A","B"]` both answer `["A","B"]` |
| A `Date` written under an *undeclared* key loses its type | It reads back as PostgreSQL's `timestamptz` text form rather than as a `Date`. Declare the field to keep the type |
| One `insert` call caps at roughly two to four thousand documents | The wire protocol caps a bind at 65535 parameters and the bind list is O(documents × columns). The driver's message names nothing useful. Batch in the caller |
| A duplicate `_id` **within one batch** raises | PostgreSQL will not let one statement write the same row twice; picking a winner would be inventing a rule the interface does not state |
| A declared column set to `null` holds SQL NULL; an *undeclared* key set to `null` holds a stored JSON null | A typed column cannot represent the difference between the two, and `_extra` can |
| `orderBy`, `getAll` and `between` on an *undeclared* field use jsonb's type-first ordering | There is no declared type to compare by, and no index to serve it |
| `distinct` discards the ordering ahead of it | `SELECT DISTINCT … ORDER BY <other>` is not valid SQL. Both other backends drop it too |
| A negative or unreadable `slice` bound is clamped, not counted from the end | A bare negative `LIMIT` raises and loses the whole statement |
| `get(k)` under `CROSS_INSTANCE` picks the lowest `_instance` holding the key | `_id` is unique *per instance*, so reading every instance at once makes one key name one row per instance. The same row is chosen on every call, and it is the row a subsequent delete removes |
| `update(fn)` with an *expression* body answers rows matched, where every other write answers rows modified | The modified test cannot be spelled for that one shape without evaluating the mapper twice per row |
| `match` uses PostgreSQL's regex engine | A literal pattern's `\b`, `\B` and unescaped `.` are translated to match JavaScript's meaning. Named capture groups and `\p{…}` raise rather than misbehaving quietly |

Coming from another backend:

| | |
| --- | --- |
| `avg` of an empty stream | `null` here and in the MongoDB backend; RethinkDB raises. `sum` of nothing is `0` |
| `nth` past the end | `null`, which is what the interface declares. RethinkDB raises and MongoDB answers `undefined` |
| `hasfields` on a present non-object | `false`. Both other backends raise |
| `filter(…).slice(0, 5).delete()` | Deletes five rows. The MongoDB backend discards the sort and limit and deletes every match |

## Development

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

`pnpm test` is the full conformance run and needs a Docker daemon. No test cases live in this repo:
the suite ships in the interface package and is discovered automatically from
`antelopeJs.implements`, so building and booting the module is all that is needed to exercise it.
The change-feed suite fails by design, for the reason given under [Not supported](#not-supported).

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
