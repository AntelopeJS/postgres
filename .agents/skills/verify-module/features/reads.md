---
covers:
  - src/implementations/database/query.ts
  - src/implementations/database/pipeline.ts
  - src/implementations/database/stage.ts
  - src/implementations/database/stages-*.ts
  - src/implementations/database/render.ts
  - src/implementations/database/row-source.ts
  - src/implementations/database/selection.ts
  - src/implementations/database/cursors.ts
  - src/implementations/database/result.ts
  - src/implementations/database/subquery.ts
  - src/implementations/database/relation.ts
  - src/implementations/database/member.ts
  - src/implementations/database/expression.ts
  - src/implementations/database/readings.ts
  - src/implementations/database/fields.ts
  - src/implementations/database/sql.ts
  - src/implementations/database/guards.ts
  - src/implementations/database/context.ts
  - src/implementations/database/utils.ts
docs:
  - docs/behaviour.md
  - docs/storage.md
journeys:
  - read-queries
---

# Reads

Queries on an owned instance, compiled to SQL and iterated through cursors.

## Sub-features

- `read-queries`: `filter` with `orderBy`, `orderBy` descending with `pluck`, `between` on an index, `getAll` on an index, `count` over an `includes` filter on a `jsonb` array and `group(index, (rows, key) => rows.count())` each answer what the same SQL answers over the stored rows; `lookup` joins the matching row under the local key; `for await` over a stream reads every row with `cursorBatchSize: 2`, past several batches.

## How to get to it (user POV)

- The AQL query builder of `@antelopejs/interface-database` in a consumer module.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" reads
```

## Gotchas

- The expression stages (string, date, numeric, array, object) are many; the journey drives a representative path through the compiler, and the unit specs under `src/test/unit/expression-*.spec.ts` and `pipeline-*.spec.ts` cover each stage.
