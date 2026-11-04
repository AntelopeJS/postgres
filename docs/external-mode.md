---
title: External mode
description: Reference for serving the existing tables of a database that the PostgreSQL module does not own, from registration and values to writes, refusals and the catalog.
mode: reference
---

`mode: "external"` points the module at tables that already exist, in a database it does not own, and reads and writes their rows. It describes an existing database to AntelopeJS, usually through a schema written from the client's catalog. It never changes the structure of that database.

```typescript fragment
{
    mode: "external",
    url: "postgres://dms_reader@client-db:5432/erp",
}
```

`url` is required. An external instance without one, or with an empty one, refuses to construct. It does not fall back to the default of the owned mode. Projects usually set it through `envOverrides`, so the credentials stay out of the repository:

```typescript fragment
envOverrides: { ERP_DATABASE_URL: "modules.postgres-erp.config.url" },
```

A project that needs both kinds of table runs two instances of this module, one owned and one external. It pins each consumer to one instance through `importOverrides`.

## The schema mirrors the database

Nothing is mapped. The declaration uses the database's own names, verbatim:

- The schema id is the PostgreSQL schema: `RegisterSchema("sales")`.
- The table id is the table, view or materialized view: `@RegisterTable("accounts", "sales")`.
- A field is a column: `@Field("string") declare first_name: string`.

The module quotes names as they are and never prefixes or shortens them.

## What registration does

Registration reads the catalog once per declared table, and does nothing else. It runs no DDL, creates no bookkeeping schema, installs no trigger, and keeps no change log. A failure here fails the schema's registration, so every query on the schema fails with the same message from startup. These declarations fail:

- A declared table that does not exist or cannot be read.
- A declared field whose column does not exist.
- A declared type that the column cannot be read as, such as `number` over a `uuid`.

Registration accepts some pairings with a warning, because reading them loses something. A `bigint` or `numeric` read as a `number` loses precision, so declare it `string` to read it exactly. `json` read as `jsonb` and microseconds on timestamps lose detail too. Registration also accepts, with a warning, a declared index that no btree index of the database backs. The query stays correct, and may be slow.

## Values

The module reads each column as the type that its field declares, the same way whatever the time zone of the server or of the Node.js process:

- `timestamp without time zone` reads as UTC, and `date` as midnight UTC.
- `bigint`, `numeric`, `uuid` and enums declared `string` read as their exact text.
- Comparisons, `get`, `getAll`, `lookup` and `orderBy` compare the column in its own type, so the database's indexes serve them. A value that is not valid for the column, such as a malformed uuid or an unknown enum label, matches nothing. It does not fail the query.
- Sorting follows the column's own order. An enum sorts in its declared order, and a `bigint` declared `string` sorts numerically.
- Equality on a `citext` column ignores case, as the column does.

## `_id`

Every row of a table with a key answers `_id`, the key as a string, beside the key columns under their own names. Declare it as `@Field("string") declare _id: string`.

- With a single-column primary key, `_id` is its value: `"42"`.
- With a composite primary key, `_id` is its parts as a JSON array of strings: `["42", "3"]`.
- With no primary key but a unique index over `NOT NULL` columns, that index is the key. If several qualify, the one with the fewest columns wins, then the first by name.

The module reads a relation with no key at all without `_id`. Such a relation is a table without a primary key or such an index, a view, a materialized view, or a foreign table. Queries, counts and aggregations work. `get`, `getAll` without an index, and `_id` itself are refused, and declaring `_id` on such a relation fails registration.

## Writing

`insert`, `update`, `replace` and `delete` work on every relation that has a key, as described above. A relation without a key is read-only.

- A payload names declared fields only. The module refuses any other key by name, `_internal` included.
- `_id` and the key columns say which row is written, and the module never assigns them. An `update` whose `_id` names another row writes nothing and answers 0. On `insert`, they are the new row's key.
- The database fills generated columns, identity columns `GENERATED ALWAYS`, and array columns. `update` and `replace` ignore a value for one of them, so writing back a whole row that you read works. `insert` refuses such a value.
- A field that an `insert` leaves out takes the column's `DEFAULT`. A field that `replace` leaves out takes its `DEFAULT` too, or NULL when it has none. `update` clears a field given as `undefined` or `null`.
- The module checks every value against its column's exact type before it writes anything. A value that does not fit refuses the write and names the field. Examples are a malformed uuid, an unknown enum label, a string too long for `varchar(n)`, a number beyond `numeric(p,s)`, and a fraction for an integer.
- A column keeps its stored value when the written value equals what a read of it answers. A row that you read and write back whole therefore loses nothing that a read could not spell, such as a `bigint` beyond 2^53 read as a number, microseconds, or duplicate keys in `json`. A write that changes nothing changes no row and answers 0.
- `insert` answers each new row's `_id` in input order, keys that the database generates included.
- A constraint that the database enforces surfaces as an `ExternalWriteError`. Its `kind` is `missing`, `duplicate`, `reference`, `referenced`, `check` or `forbidden`, and it names the field or the constraint concerned.

Triggers, cascades and other writers on the client's side belong to the client. Nothing reports what they change.

## What is refused

Each of these fails with a message that names what was refused:

- Writes to a relation without a key, and `atomicMutation`.
- `update` with an expression mapper, such as `update(row => …)`.
- `changes()`.
- A named instance, `createInstance` and `destroyInstance`. `listInstances` answers an empty list. External tables have no instances, so the default instance and `CROSS_INSTANCE` both read every row.

A read does not refuse a field that the declaration does not name. The field is absent, as on any document that lacks it.

## The account to connect with

Give the module an account that can read, can write the rows it should, and can do nothing else:

```sql
CREATE ROLE dms_client LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA sales TO dms_client;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO dms_client;
GRANT INSERT, UPDATE, DELETE ON sales.orders, sales.customers TO dms_client;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA sales TO dms_client;
```

A write to a table that the account was not granted fails as `forbidden`. The module never needs more. With this account, a module wired by mistake to an owned instance on this URL fails at its first `CREATE` and does not change the client's database. Set `statementTimeoutMs` too, because these are someone else's production tables.

## The catalog

An external instance also implements `@antelopejs/interface-database-catalog`. The catalog describes and profiles the database for a generator: relations, columns, keys, references, row estimates, and aggregates over the data. It answers with this module's own registration rules. A relation that it calls mappable registers, and the declarations that it lists for a column are the ones that registration accepts.

The catalog is a development tool. It answers under `ajs project dev` and `ajs project run`. It refuses under `ajs project start` unless you turn it on:

```typescript fragment
{
    mode: "external",
    url: "…",
    catalog: { enabled: true },
}
```

An owned instance refuses it.

### A connection that fails at startup

Wherever the catalog answers, an external instance whose first connection fails still starts. The catalog answers in development unless `catalog.enabled` says otherwise. The instance keeps the failure as the reason it has no connection, and every catalog and database call refuses with `PostgreSQL adapter is not connected: <reason>`. A builder can then show the reason and let someone fix the URL, and a typo does not stop the whole project.

The module words the common reasons as a sentence and keeps the driver's code:

| Code                                     | Reason                                     |
| ---------------------------------------- | ------------------------------------------ |
| `28P01`                                  | wrong user or password                     |
| `3D000`                                  | the database does not exist                |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` | the server is not answering at `host:port` |
| `28000`, refused without encryption      | the server requires SSL                    |

Any other failure keeps the driver's message. Nothing retries in place. The instance connects again when the project reloads and constructs it again, for example after its URL changes in `.env`.

Nothing else changes. Without `url`, an external instance still refuses to construct. Where the catalog does not answer, as under `ajs project start`, a failed connection fails construct. An owned instance always fails construct when it cannot connect.

Each consumer reaches the catalog through a connection on its own module entry. Two consumers of the same database give their connections the same id:

```typescript fragment
"dms-builder": {
    importOverrides: [
        { interface: "@antelopejs/interface-database-catalog", source: "postgres-erp", id: "erp" },
    ],
},
"dms-ai": {
    importOverrides: [
        { interface: "@antelopejs/interface-database-catalog", source: "postgres-erp", id: "erp" },
    ],
},
```

**Profiles never write and never wait long.**

- Every profile runs in one `READ ONLY` transaction, whatever the connected role may write. Each measure has a 5 s statement timeout and a 1 s lock timeout.
- A measure that times out answers `{ status: "timeout" }`, and the rest of the profile stands.
- A table, partitioned table or materialized view estimated above one million rows is sampled with `TABLESAMPLE SYSTEM`. Any other relation above that size, such as a view, is read up to its first 100,000 rows.
- Calls run one at a time.

**Profiles answer aggregates, not rows.**

- Text columns answer no minimum or maximum.
- A profile names a value only as a category of a column with at most 25 distinct values, and only if the value is counted at least 5 times.
- The profile does not read values from `pg_stats`.

**A sample of rows is for a person.** `SampleRows` is the one catalog function that answers row values. They are for a person to look at, never for a generator or a model.

- It answers at most 20 rows, every value as text cut at 200 characters, and a binary value as its length.
- It reads in the same `READ ONLY` transaction and with the same timeouts as a profile, and samples a relation above one million rows the same way.
