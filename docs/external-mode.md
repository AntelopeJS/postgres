# External mode

`mode: "external"` points the module at tables that already exist, in a database it does not own,
and reads them. It is for describing an existing database to AntelopeJS, typically a schema written
by inspecting the client's catalog, and for nothing that would change that database.

```typescript
{
    mode: "external",
    url: "postgres://dms_reader@client-db:5432/erp",
}
```

A project that needs both kinds of table runs two instances of this module, one owned and one
external, and pins each consumer to one through `importOverrides`.

## The schema mirrors the database

Nothing is mapped. The declaration uses the database's own names, verbatim:

- the schema id is the PostgreSQL schema: `RegisterSchema("sales")`
- the table id is the table, view or materialized view: `@RegisterTable("accounts", "sales")`
- a field is a column: `@Field("string") declare first_name: string`

Names are quoted as they are and never prefixed or shortened.

## What registration does

It reads the catalog, once per declared table, and nothing else. No DDL runs, no bookkeeping
schema is created, no trigger is installed and no change log is kept. A failure here fails the
schema's registration, so every query on it fails with the same message from startup:

- a declared table that does not exist or cannot be read
- a declared field whose column does not exist
- a declared type the column cannot be read as, such as `number` over a `uuid`

Some pairings are accepted with a warning because reading them loses something: a `bigint` or
`numeric` read as a `number` (declare it `string` to read it exactly), `json` read as `jsonb`, and
microseconds on timestamps. A declared index that no btree index of the database backs is accepted
with a warning too: the query stays correct, and may be slow.

## Values

Each column is read as the type its field declares, the same way whatever the server's or the
Node process's time zone:

- `timestamp without time zone` is read as UTC, and `date` as midnight UTC
- `bigint`, `numeric`, `uuid` and enums declared `string` are read as their exact text
- comparisons, `get`, `getAll`, `lookup` and `orderBy` compare the column in its own type, so the
  database's indexes serve them; a value that is not valid for the column (a malformed uuid, an
  unknown enum label) matches nothing rather than failing the query
- sorting follows the column's own order: an enum sorts in its declared order, a `bigint` declared
  `string` numerically
- equality on a `citext` column ignores case, as the column does

## `_id`

Every row of a table with a key answers `_id`, the key as a string, beside the key columns
themselves under their own names. Declare it as `@Field("string") declare _id: string`.

- a single-column primary key: `_id` is its value, `"42"`
- a composite primary key: `_id` is its parts as a JSON array of strings, `["42", "3"]`
- no primary key, but a unique index over `NOT NULL` columns: that index is the key, the one with
  the fewest columns first, then by name

A relation with no key at all — a table without a primary key or such an index, a view, a
materialized view, a foreign table — is read without `_id`. Queries, counts and aggregations work;
`get`, `getAll` without an index and `_id` itself are refused, and declaring `_id` on it fails
registration.

## What is refused

Every one of these fails with a message naming what was refused:

- writes: `insert`, `update`, `replace`, `delete`, `atomicMutation`
- `changes()`
- a named instance, `createInstance` and `destroyInstance`; `listInstances` is empty. External
  tables have no instances: the default instance and `CROSS_INSTANCE` both read every row

A field the declaration does not name is not refused when read: it is absent, as on any document
that lacks it.

## The account to connect with

Give the module an account that can read and do nothing else:

```sql
CREATE ROLE dms_reader LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA sales TO dms_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO dms_reader;
```

The module never needs more, and a module wired by mistake to an owned instance on this URL then
fails at its first `CREATE` instead of changing the client's database. Set `statementTimeoutMs`
too: these are someone else's production tables.
