# postgres

The PostgreSQL implementation of `@antelopejs/interface-database` and `@antelopejs/interface-database-catalog`, published as `@antelopejs/postgres`.

## Layout

- `src/index.ts`, `src/config.ts` and `src/connection.ts` hold the module lifecycle, its config and the `pg` pool.
- `src/implementations/database/` implements the Database interface; the `external-*.ts` files are the external mode, which reads and writes tables the module did not create. `src/implementations/catalog/` implements the catalog interface.
- `src/test/*.test.ts` are the integration suites `ajs module test` runs against a real PostgreSQL; `src/test/unit/*.spec.ts` are database-free unit suites. `src/test-external/` holds the external-mode suites and the client fixture they read.
- `docs/` holds the user documentation linked from `README.md`.

## Versioning

- Both implemented interfaces stay capped below the next minor (`interface-database` `>=0.4.0 <0.5.0`, `interface-database-catalog` `>=0.1.0 <0.2.0`), because a new minor can add required handlers. `pnpm run checks` enforces it with its `dependency:ranges` step.
- When a dependency range changes, update the compatibility table in `README.md` too.
- A release that needs action from users gets an `### Upgrade notes` section in `CHANGELOG.md`, above the generated entries.

## Tests

- README "Contributing" owns the Node floor and the `PG_TEST_URL` safety rule; read it before running database tests. CI runs only the `.nvmrc` version.
- `pnpm test` (and so `pnpm run checks`) pulls `postgres:18-alpine` in the background, builds `dist` once, then runs `ajs module test .` with the test project in `src/test/antelope.test.ts`: every suite in `dist/test` (unit specs included) plus the shared conformance suites of the implemented interfaces. `scripts/test.sh` runs the external-mode suites in `dist/test-external` with `PG_TEST_MODE=external` at the same time, each run in its own `postgres:18-alpine` container started through Testcontainers, and prints the external output after the first run ends. Both runs need Docker unless `PG_TEST_URL` is set. Then both use that server and run one after the other, because change feeds deliver only rows below the cluster-wide `pg_snapshot_xmin`, which a concurrent run's transactions hold back.
- `pnpm test:unit` runs only the database-free unit specs with Mocha; `pnpm test:external` runs only the external-mode suites. Neither is needed after `checks`, which already runs both.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, run only the fast check for what you touched:

- `pnpm run typecheck` after you change types or signatures.
- `pnpm exec oxlint <files>` and `pnpm exec oxfmt <files>` on the files you changed.
- One test file, not the suite. In a module that tests with `ajs module test`: `pnpm run build`, then `pnpm exec ajs module test . -f dist/<path>.test.js`.

Prove a change works with the verification skill in [`.agents/skills/verify-module/SKILL.md`](.agents/skills/verify-module/SKILL.md) before you call it done.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->
