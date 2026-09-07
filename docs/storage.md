# Storage and schema

How a registered schema becomes real PostgreSQL objects, which field types map to which
column types, what reaches an index, and how registration reconciles the two.

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
  is the _leading_ column of the primary key — so `WHERE _instance = $1` is served by the primary
  key with no extra index, and `CROSS_INSTANCE` is simply the absence of that predicate. Every
  document a read answers carries the instance it came from under `_instance`, which is how a
  `CROSS_INSTANCE` read tells its rows apart; the default instance carries no key at all rather
  than the empty string it is stored as.
- **`_extra jsonb` absorbs undeclared fields.** Writing a field your schema does not declare is
  allowed and round-trips; it just lives in `_extra` rather than in a column of its own, with the
  consequences listed under [Behaviour worth knowing](./behaviour.md).
- **`_id`, `_instance` and `_extra` are reserved**, in the sense that the adapter owns the columns
  and no declared field may land in one. They are not equally undeclarable: declaring `_instance` or
  `_extra` is an error at registration, while declaring `_id` restates the key column the adapter
  already stores and is accepted — as `string` and no other type, since the column is `text`
  whatever a schema says. It adds no column and the field is dropped from the shape.
- **A write payload may name `_id` and `_instance`, but not `_extra`.** A payload's `_id` is an
  assertion about which row is being written rather than an assignment, and its `_instance` is
  dropped: it restates where the row already is, and no write moves a row between instances. Both
  are what make writing a document straight back a no-op rather than an error. Naming `_extra` is an
  error at query time.
- **Instances are tracked in a `__antelope` schema**, in
  `instances(schema_id, instance_id, created_at)`. `destroyInstance` deletes rows and never drops a
  schema or a table, as a single statement so a partial destroy cannot leave an instance half-wiped.

Identifiers longer than PostgreSQL's 63-byte limit are truncated to 55 bytes plus a hash suffix.
Registration refuses a collision loudly rather than letting two fields share a column, so a column
name is not always the field name verbatim.

## Field types

The accepted token set is closed and **case-insensitive** — `"date"` and `"Date"` both work.

| Declared                              | Column type        | Notes                                                                                               |
| ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `string`                              | `text`             |                                                                                                     |
| `number`                              | `double precision` | JS numbers _are_ float64, so this is exact rather than a compromise                                 |
| `boolean`                             | `boolean`          |                                                                                                     |
| `date`                                | `timestamptz`      | read back as a `Date`                                                                               |
| `object` / `any`                      | `jsonb`            | no declared shape                                                                                   |
| nested record, e.g. `{ a: "number" }` | `jsonb`            | shape is remembered for type inference                                                              |
| `"string[]"` or `["string"]`          | `jsonb`            | see below                                                                                           |
| io-ts codec at the field root         | `jsonb`            | **the codec is recorded and never invoked** — the field behaves as a plain shapeless `jsonb` column |
| anything else                         | —                  | error at registration, naming the field                                                             |

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

| Change                                 | `safe` (default)           | `destructive`         |
| -------------------------------------- | -------------------------- | --------------------- |
| New declared field                     | `ADD COLUMN`               | `ADD COLUMN`          |
| Declared type differs from the column  | **error naming the field** | `ALTER COLUMN … TYPE` |
| Column exists, no longer declared      | warning, column kept       | `DROP COLUMN`         |
| Index missing                          | `CREATE INDEX`             | same                  |
| Index definition changed               | `DROP` + `CREATE`          | same                  |
| Adapter-owned index no longer declared | `DROP INDEX`               | same                  |
| Index this adapter did not create      | left alone                 | left alone            |

A type mismatch is fatal under `safe` because it is otherwise a _query-time_ failure, silent until
the first read. Dropping an index loses no data, which is why the index rows need no opt-in.

**A newly added column is backfilled out of `_extra` in the same transaction.** Adding a field to a
schema that already has rows moves the existing values from the overflow document into the new
column, so a row does not go on displaying a value that `filter` can no longer find. The move is
lossless: a stored value the new column cannot hold — the wrong JSON type for the declared one —
stays in `_extra`, where it can still be read, rather than being dropped or coerced.

Each schema converges in one transaction, and adapter-owned indexes are recognised by a signature
stored as the index comment rather than by parsing the index definition back.

**Several processes may converge the same schema at once.** Whichever loses the race to create an
object sees the catalog's duplicate-object error, re-reads what is now there, and plans the no-op
that is left; there is no lock to take and no ordering to arrange between deployments.
