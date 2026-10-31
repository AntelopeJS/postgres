# External mode

`mode: "external"` points the module at tables that already exist, in a database it does not own,
and reads and writes their rows. It is for describing an existing database to AntelopeJS, typically
a schema written by inspecting the client's catalog. It never changes that database's structure.

```typescript fragment
{
    mode: "external",
    url: "postgres://dms_reader@client-db:5432/erp",
}
```

`url` is required: an external instance without one, or with an empty one, refuses to construct,
rather than falling back to the owned mode's default. Projects normally set it through
`envOverrides`, so the credentials stay out of the repository:

```typescript fragment
envOverrides: { ERP_DATABASE_URL: "modules.postgres-erp.config.url" },
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

## Writing

`insert`, `update`, `replace` and `delete` work on every relation that has a key (above). A relation
without one is read-only.

- A payload names declared fields only: any other key, `_internal` included, is refused by name
- `_id` and the key columns say which row is written, and are never assigned: an `update` whose `_id`
  names another row writes nothing and answers 0. On `insert` they are the new row's key
- Generated columns, identity columns `GENERATED ALWAYS` and array columns are left to the database:
  a value for one is ignored by `update` and `replace` (so a row read and written back whole works)
  and refused by `insert`
- A field an `insert` leaves out takes the column's `DEFAULT`; a field `replace` leaves out takes its
  `DEFAULT` too, or NULL when it has none; `update` clears a field given as `undefined` or `null`
- Every value is checked against its column's exact type before anything is written, and one that
  does not fit — a malformed uuid, an unknown enum label, a string too long for `varchar(n)`, a
  number beyond `numeric(p,s)`, a fraction for an integer — refuses the write, naming the field
- A column keeps its stored value when the written value equals what a read of it answers, so a row
  read and written back whole loses nothing a read could not spell: a `bigint` beyond 2^53 read as a
  number, microseconds, duplicate keys in `json`. A write that changes nothing changes no row and
  answers 0
- `insert` answers each new row's `_id` in input order, keys the database generates included
- A constraint the database enforces surfaces as an `ExternalWriteError` whose `kind` is `missing`,
  `duplicate`, `reference`, `referenced`, `check` or `forbidden`, with the field or the constraint
  it is about

Triggers, cascades and other writers on the client's side are theirs: nothing reports what they
change.

## What is refused

Every one of these fails with a message naming what was refused:

- writes to a relation without a key, and `atomicMutation`
- `update` with an expression mapper (`update(row => …)`)
- `changes()`
- a named instance, `createInstance` and `destroyInstance`; `listInstances` is empty. External
  tables have no instances: the default instance and `CROSS_INSTANCE` both read every row

A field the declaration does not name is not refused when read: it is absent, as on any document
that lacks it.

## The account to connect with

Give the module an account that can read, and write the rows it should, and nothing else:

```sql
CREATE ROLE dms_client LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA sales TO dms_client;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO dms_client;
GRANT INSERT, UPDATE, DELETE ON sales.orders, sales.customers TO dms_client;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA sales TO dms_client;
```

A write to a table it was not granted fails as `forbidden`. The module never needs more, and a
module wired by mistake to an owned instance on this URL then fails at its first `CREATE` instead of
changing the client's database. Set `statementTimeoutMs`
too: these are someone else's production tables.

## The catalog

An external instance also implements `@antelopejs/interface-database-catalog`, which describes and
profiles the database for a generator: relations, columns, keys, references, row estimates, and
aggregates over the data. It answers with this module's own registration rules, so a relation it
calls mappable registers, and the declarations it lists for a column are the ones registration
accepts.

It is a development tool. It answers under `ajs project dev` and `ajs project run`, and refuses under
`ajs project start` unless enabled explicitly:

```typescript fragment
{
    mode: "external",
    url: "…",
    catalog: { enabled: true },
}
```

An owned instance refuses it.

### A connection that fails at startup

Wherever the catalog answers, which is in development unless `catalog.enabled` says otherwise, an
external instance whose first connection fails still starts. It keeps the failure as the reason it
has no connection, and every catalog and database call refuses with
`PostgreSQL adapter is not connected: <reason>`. A builder can then show the reason and let the URL
be fixed, instead of the whole project stopping on a typo.

The common reasons read as a sentence, followed by the driver's code:

| Code                                     | Reason                                     |
| ---------------------------------------- | ------------------------------------------ |
| `28P01`                                  | wrong user or password                     |
| `3D000`                                  | the database does not exist                |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` | the server is not answering at `host:port` |
| `28000`, refused without encryption      | the server requires SSL                    |

Any other failure keeps the driver's message. Nothing retries in place: the instance connects again
when the project reloads and constructs it again, for instance after its URL changes in `.env`.

Elsewhere nothing changes. Without `url` an external instance still refuses to construct, a failed
connection fails construct where the catalog does not answer, as under `ajs project start`, and an
owned instance always fails construct when it cannot connect.

Each consumer reaches the catalog through a connection on its own module entry, and two consumers
of the same database give theirs the same id:

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

- Every profile runs in one `READ ONLY` transaction, whatever the connected role may write, with a
  5 s statement timeout and a 1 s lock timeout per measure.
- A measure that times out answers `{ status: "timeout" }`, and the rest of the profile stands.
- A relation estimated above one million rows is sampled with `TABLESAMPLE SYSTEM`. A view above
  that size is read up to its first 100,000 rows.
- Calls run one at a time.

**Profiles answer aggregates, not rows.**

- Text columns answer no minimum or maximum.
- A value is named only as a category of a column with at most 25 distinct values, and only if
  it is counted at least 5 times.
- `pg_stats` is not read for values.

**A sample of rows is for a person.** `SampleRows` is the one catalog function that answers row
values, for a person to look at, never for a generator or a model.

- At most 20 rows, every value as text cut at 200 characters, and a binary value as its length.
- It reads in the same `READ ONLY` transaction and with the same timeouts as a profile, and
  samples a relation above one million rows the same way.
