---
covers:
  - src/connect-failure.ts
  - src/implementations/catalog/**
  - src/implementations/database/external-catalog.ts
  - src/implementations/database/external-discovery.ts
  - src/implementations/database/external-declarations.ts
  - src/implementations/database/external-rows.ts
  - src/implementations/database/external-column-profile.ts
  - src/implementations/database/external-profile.ts
  - src/implementations/database/external-measures.ts
  - src/implementations/database/external-reference.ts
  - src/implementations/database/external-sample.ts
docs:
  - docs/external-mode.md
  - docs/errors.md
journeys:
  - catalog-describe
  - catalog-refused
---

# Catalog

`@antelopejs/interface-database-catalog` on an external instance.

## Sub-features

- `catalog-describe`: `Info` answers the engine, database and role; `ListRelations` answers each relation with its kind, key and what the account may write; `DescribeRelations` answers the comment and the columns; `Profile` names the categories of a column with few distinct values; `SampleRows` answers the requested columns and rows as text; the client's database is unchanged afterwards.
- `catalog-refused`: an owned instance refuses the catalog; `catalog.enabled: false` refuses it under `ajs project dev` while the database interface still answers; an external instance whose server does not answer still starts in development, and both the catalog and a query refuse with `PostgreSQL adapter is not connected: <reason>`.

## How to get to it (user POV)

- A generator module that imports `@antelopejs/interface-database-catalog`, under `ajs project dev`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" catalog
```

## Gotchas

- `src/connect-failure.ts` words a failed first connection only where the catalog answers, so this feature covers it beside `module`, whose `src/*.ts` glob also matches it.
- `external-catalog.ts` reads the columns and keys that external registration uses too, so `external` covers it as well.
- `estimatedRows` comes from PostgreSQL's statistics and is not asserted.
- The refusal under `ajs project start` without `catalog.enabled` is not driven, because `context.dev` runs only `ajs project dev`.
- `CheckReference` and the inbound and reference parts of a profile are not driven.
