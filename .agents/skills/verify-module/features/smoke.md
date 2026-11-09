---
covers:
docs:
  - README.md
journeys:
  - module-dev
  - insert-values
---

# Smoke

The fixed journey every verdict runs, whatever the diff touches: load the module as `local` against the run's PostgreSQL container, write documents through a consumer module and read the stored rows back with `psql`.

## Sub-features

- `module-dev`: the pack's journey. As for every journey, the harness reruns the service's readiness command when it fails, so a PostgreSQL that stopped answering ends it NOT VERIFIED, not FAIL.
- `insert-values`: as in [writes](writes.md).

## How to get to it (user POV)

- A project with `@antelopejs/postgres` and a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" smoke
```

## Gotchas

- The service's `reset` drops and recreates the `verify` database, the `client` database and the `verify_reader` role before every journey, so each starts from an empty server.
- The smoke feature covers no glob, so it never marks a file as mapped.
