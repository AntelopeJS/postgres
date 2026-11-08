---
covers:
  - src/implementations/database/writes*.ts
  - src/implementations/database/payload.ts
  - src/implementations/database/coerce.ts
  - src/implementations/database/value.ts
  - src/implementations/database/jsonb.ts
docs:
  - docs/storage.md
  - docs/behaviour.md
  - docs/errors.md
journeys:
  - insert-values
  - update-replace-delete
---

# Writes

Writing documents into an owned instance and the column types they land in.

## Sub-features

- `insert-values`: an array insert resolves to one generated id per document; each declared type lands in its documented column type; an undeclared field round-trips through `_extra`; a named instance's document carries `_instance`.
- `update-replace-delete`: `update` keeps the fields it does not name, `replace` clears them, `delete` removes the row, and inserting a taken `_id` throws `DuplicateKeyError`.

## How to get to it (user POV)

- `table.insert`, `get(id).update/replace/delete` from a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" writes
```

## Gotchas

- `atomicMutation` and expression mappers in `update` are not driven here; the unit specs under `src/test/unit/writes-*.spec.ts` cover them.
