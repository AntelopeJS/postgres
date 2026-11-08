---
covers:
  - src/implementations/database/external-schema.ts
  - src/implementations/database/external-catalog.ts
  - src/implementations/database/external-types.ts
  - src/implementations/database/external-payload.ts
  - src/implementations/database/external-writes.ts
  - src/implementations/database/external-errors.ts
  - src/implementations/database/external-refusals.ts
docs:
  - docs/external-mode.md
  - docs/errors.md
journeys:
  - external-read-write
  - external-registration
---

# External mode

An external instance on a client database the module does not own, connected as an account that reads every table and writes one.

## Sub-features

- `external-read-write`: rows read under their own column names with `_id` as the key's text, a `bigint` declared `string` as its exact text and a `timestamptz` as its instant; an enum compares as its label; a view reads without a key; `insert` answers the generated key; an `update` answers 1 when it changes the row and 0 when it does not; refusals of an undeclared payload key, a value too long for `varchar(20)`, an unknown enum label, a value for an identity column, a write to a table the account was not granted (`ExternalWriteError` of kind `forbidden`), `changes()`, `createInstance` and `get` on a keyless view; `listInstances` answers `[]`; `psql` shows the written rows and no `__antelope` schema or trigger in the client's database.
- `external-registration`: a declared column the table lacks fails registration naming the field and the column, and no query on the schema answers.

## How to get to it (user POV)

- `mode: "external"` and the client's `url` in the module's config, and a schema declared with the database's own names.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" external
```

## Gotchas

- The client database, the `verify_reader` account and their rows are created by `psql` as the server's owner, never by the module; the service's `reset` drops them before each journey.
