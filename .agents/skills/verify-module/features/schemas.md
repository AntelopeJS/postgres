---
covers:
  - src/implementations/database/schema.ts
  - src/implementations/database/ddl.ts
  - src/implementations/database/migrate.ts
  - src/implementations/database/convergence.ts
  - src/implementations/database/instances.ts
  - src/implementations/database/introspect.ts
  - src/implementations/database/identifier.ts
  - src/implementations/database/types.ts
  - src/implementations/database/duplicate-key.ts
docs:
  - docs/storage.md
journeys:
  - storage-layout
  - migrations
---

# Schemas

What a registered schema becomes in PostgreSQL, its instances, and how registration converges a changed declaration.

## Sub-features

- `storage-layout`: one PostgreSQL schema per schema id; the primary key `(_instance, _id)`; a declared index as a btree led by `_instance`, a `crossInstance` index with its unprefixed `__g` twin, a `unique` index UNIQUE within the instance, a `multi` index over a `jsonb` field as GIN; `__antelope.instances` records each created instance; a taken unique key throws `DuplicateKeyError`; `CROSS_INSTANCE` reads every instance; `destroyInstance` deletes the instance's rows and keeps the table.
- `migrations`: a new field adds its column and moves the stored value out of `_extra`; under `safe` a changed type is refused naming the column and no read answers; under `destructive` the column is altered and a column no longer declared is dropped.

## How to get to it (user POV)

- `new Schema(id, definition)` in a consumer module, changed between two runs of `ajs project dev`, with `migrations` in the module's config.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" schemas
```

## Gotchas

- Secondary indexes build in the background after registration, so `storage-layout` polls `pg_index.indisvalid` inside the container before it reads `pg_indexes`.
- Concurrent convergence by several processes, an index left `INVALID` by a failed build, and replacement builds under `__next` are not driven: they need a crash or a second process mid-build. The unit and integration suites cover them.
