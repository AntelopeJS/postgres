---
title: Storage and schema
description: What a registered schema becomes in PostgreSQL, the field-type table, what reaches an index, and how registration converges.
mode: reference
---

How a registered schema becomes PostgreSQL objects, which field types map to which column types, what reaches an index, and how registration reconciles the declared schema with the database.

## Storage layout

A registered schema produces ordinary tables that you can inspect and query directly:

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

- **One PostgreSQL schema per AntelopeJS schema id.** The table name is the interface table name, with no name mangling. Use `schemaPrefix` when several applications share one database.
- **`_id` is `text`, not `uuid`.** Callers supply arbitrary strings such as `"user-123"`. When `_id` is absent, the adapter generates one with `node:crypto.randomUUID` before the statement runs. That is why `insert` can return the keys it created without reading anything back.
- **`_instance` is the instance discriminator.** It defaults to `''` for the unnamed instance, and it is the leading column of the primary key. The primary key therefore serves `WHERE _instance = $1` with no extra index, and `CROSS_INSTANCE` is the absence of that predicate. Every document that a read answers carries the instance it came from under `_instance`, which is how a `CROSS_INSTANCE` read tells its rows apart. A document of the default instance carries no `_instance` key at all, not the empty string it is stored as.
- **`_extra jsonb` holds undeclared fields.** You may write a field that your schema does not declare, and it round-trips. It lives in `_extra`, not in a column of its own, with the consequences listed under [Behaviour worth knowing](./behaviour.md).
- **`_id`, `_instance` and `_extra` are reserved.** The adapter owns these columns, and no declared field may land in one. The rules differ per column. Declaring `_instance` or `_extra` is an error at registration. Declaring `_id` restates the key column that the adapter already stores, and the adapter accepts it as `string` and no other type, since the column is `text` whatever a schema says. It adds no column, and the field is dropped from the shape.
- **A write payload may name `_id` and `_instance`, but not `_extra`.** A payload's `_id` is an assertion about which row is written, not an assignment. The adapter drops its `_instance`, because it restates where the row already is and no write moves a row between instances. Both rules make writing a document straight back a no-op, not an error. Naming `_extra` is an error at query time.
- **The adapter tracks instances in a `__antelope` schema**, in `instances(schema_id, instance_id, created_at)`. `destroyInstance` deletes rows and never drops a schema or a table. It runs as a single statement, so a partial destroy cannot leave an instance half wiped.

PostgreSQL limits identifiers to 63 bytes. The adapter truncates a longer identifier to 55 bytes and adds a hash suffix. Registration refuses a collision with an error, so two fields never share a column. A column name is therefore not always the field name verbatim.

## Field types

The set of accepted tokens is closed and case-insensitive. `"date"` and `"Date"` both work.

| Declared                                 | Column type        | Notes                                                                                               |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `string`                                 | `text`             |                                                                                                     |
| `number`                                 | `double precision` | JavaScript numbers are float64, so this type is exact                                               |
| `boolean`                                | `boolean`          |                                                                                                     |
| `date`                                   | `timestamptz`      | Read back as a `Date`                                                                               |
| `object` or `any`                        | `jsonb`            | No declared shape                                                                                   |
| nested record, such as `{ a: "number" }` | `jsonb`            | The shape is kept for type inference                                                                |
| `"string[]"` or `["string"]`             | `jsonb`            | See below                                                                                           |
| io-ts codec at the field root            | `jsonb`            | The adapter records the codec and never calls it. The field is a plain `jsonb` column with no shape |
| anything else                            | none               | Error at registration, naming the field                                                             |

Arrays map to `jsonb`, not to native `text[]`, for three reasons. The `jsonb` operator `->` is 0-based, which matches the interface's array indexing. `jsonb_array_elements` handles nested and mixed arrays the same way. A GIN index still serves `@>` containment.

## Indexes

A declared index becomes a real index, and the operations that can use one do:

- **Secondary btree indexes lead with `_instance`**, because every read that is not `CROSS_INSTANCE` carries `WHERE _instance = $1`. An index on `("_instance", "price")` serves `_instance = '' AND price > 1000` as one range scan. Its name is `<table>_<index>`.
- **`crossInstance: true` adds an unprefixed twin.** The adapter also maintains `<table>_<index>__g` over the same keys without `_instance`, and that twin serves a `CROSS_INSTANCE` read of the index. Without the flag, such a read stays correct but cannot use the index well. The first `getAll`, `between` or `orderBy` that names the index under `CROSS_INSTANCE` logs one warning per index per registration. A plain `filter` never warns.
- **`unique: true` makes the `_instance`-prefixed index a `UNIQUE` one.** The key is unique within each instance, and two instances may share it. The `__g` twin of a `crossInstance` index is never unique. Rows that lack a field of the key hold NULL there and never conflict. Registration refuses a unique `multi` index over an array field, because GIN cannot be unique. When a schema declares a unique index, its writes wait for its index phase, so no write can store a duplicate before the index exists. Reads never wait. A write that the index refuses throws `DuplicateKeyError`. See [Duplicate keys](./errors.md#duplicate-keys).
- **`multi` maps to GIN** over a single field backed by `jsonb`, which lets an index serve `@>`, `?`, `?|` and `?&`. A GIN index is keyed on the column alone, with no leading `_instance`. It already serves both kinds of read, so `crossInstance` changes nothing for it. `multi` on a scalar field falls back to btree instead of failing.
- **These operations reach an index:** `filter` and `orderBy` on a declared field, `get`, `getAll`, `between`, a `joinInner` predicate, and the local key of a `lookup`. The local key reaches the index also when the looked-up query only plucked its columns, because the adapter pushes the correlation under that projection onto the column itself. A projection that computed its members is not pushed under, and the lateral join then scans the other table once per row of the left.

Declaring a field is therefore the most useful thing you can do for query performance. An undeclared key lives in `_extra`, where it has no declared type to compare by and no index to serve it.

## Schema convergence

Registration reconciles the declared schema with what the database holds.

| Change                                 | `safe` (default)                                       | `destructive`         |
| -------------------------------------- | ------------------------------------------------------ | --------------------- |
| New declared field                     | `ADD COLUMN`                                           | `ADD COLUMN`          |
| Declared type differs from the column  | Error naming the field                                 | `ALTER COLUMN … TYPE` |
| Column exists, no longer declared      | Warning, column kept                                   | `DROP COLUMN`         |
| Index missing                          | `CREATE INDEX CONCURRENTLY`                            | Same                  |
| Index left `INVALID` by a failed build | `DROP` and `CREATE`, both concurrently                 | Same                  |
| Index definition changed               | Build replacement, then swap                           | Same                  |
| `unique` added or removed              | Build replacement, then swap                           | Same                  |
| Adapter-owned index no longer declared | `DROP INDEX CONCURRENTLY`                              | Same                  |
| Index this adapter did not create      | Left alone, unless it holds a name the adapter derives | Same                  |

If you add `unique` to an index over rows that already share a key, the build of the replacement fails. The adapter logs the failure, the previous index keeps serving, and the index phase stops there. The next registration tries again. Remove the duplicates, then restart.

A type mismatch is fatal under `safe` because it would otherwise be a failure at query time, silent until the first read. Dropping an index loses no data, which is why the index rows need no opt-in.

**The adapter fills a new column from `_extra` in the same transaction.** When you add a field to a schema that already has rows, the existing values move from the overflow document into the new column. A row then never shows a value that `filter` can no longer find. The move loses nothing. A stored value that the new column cannot hold, such as the wrong JSON type for the declared one, stays in `_extra`, where it can still be read. It is not dropped or coerced.

The adapter recognizes the indexes it owns by a signature stored as the index comment, not by parsing the index definition back.

**The adapter owns every index name it derives.** A declared index `<index>` on table `<table>` is named `<table>_<index>`. A `crossInstance` index adds its twin `<table>_<index>__g`. A rebuild stages each of them under the same name plus `__next`. An index the adapter did not create is left alone under any other name. At one of these names it is treated as the adapter's own: replaced like a drifted index, or dropped when it sits at a `__next` name. The adapter cannot tell such an index from one of its own builds that stopped between `CREATE INDEX CONCURRENTLY` and the `COMMENT ON INDEX` that signs it, because the two cannot share a transaction. Give a hand-made index a name outside this pattern, such as `users_email_by_hand` next to a declared index `email` on `users`.

**Schemas, tables and columns converge in one transaction. Indexes converge after it, in the background.** A schema is ready for queries as soon as that transaction commits. No query ever waits for a secondary index, and results never depend on whether one exists yet. The adapter then builds every secondary index with `CREATE INDEX CONCURRENTLY`, so a table keeps taking reads and writes while an index is added to it, however large the table is. The adapter logs a failed build, and the next registration repairs it:

- An index under one of the adapter's names that a failed or interrupted build left `INVALID` (`pg_index.indisvalid = false`) serves no read. The next convergence drops it concurrently and builds it again.
- An index whose definition changed keeps serving while the adapter builds its replacement under `<name>__next`. Only once the replacement is valid does the adapter drop the old index and rename the replacement.
- The adapter drops the owned indexes that nothing declares any more last, after every build succeeded. No index is dropped before the one that replaces it is valid.
- The one exception is a column type change under `destructive`. It rewrites the table under an exclusive lock anyway, so the adapter drops the indexes it would otherwise rebuild in an incompatible shape inside the transaction, before the `ALTER`.

**Several processes may converge the same schema at once.** A transaction-scoped PostgreSQL advisory lock per schema serializes the tables phase. The process that goes second waits for the first to commit, reads the catalog again, and finds nothing left to do. Waiting is safe there because that phase never builds an index concurrently. The index phase takes a second, session-level advisory lock per schema with a single `pg_try_advisory_lock` and never waits for it. A process that finds the lock held skips the phase, because another process is already building the same indexes. A dedicated connection holds that lock. The lock is released when the phase ends, and with the connection when a build fails or the adapter disconnects, which cancels the running build. The next registration repairs any build that a crash or a shutdown left `INVALID`. A duplicate-object error from something outside those locks still reads the catalog again and plans the no-op that is left.
