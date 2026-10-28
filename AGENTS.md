# postgres

The PostgreSQL implementation of `@antelopejs/interface-database` and `@antelopejs/interface-database-catalog`, published as `@antelopejs/postgres`.

## Layout

- `src/index.ts`, `src/config.ts` and `src/connection.ts` hold the module lifecycle, its config and the `pg` pool.
- `src/implementations/database/` implements the Database interface; the `external-*.ts` files are the external mode, which reads and writes tables the module did not create. `src/implementations/catalog/` implements the catalog interface.
- `src/test/*.test.ts` are the integration suites `ajs module test` runs against a real PostgreSQL; `src/test/unit/*.spec.ts` are database-free unit suites. `src/test-external/` holds the external-mode suites and the client fixture they read.
- `docs/` holds the user documentation linked from `README.md`.

## Versioning

- Both implemented interfaces stay capped below the next minor (`interface-database` `>=0.2.0 <0.3.0`, `interface-database-catalog` `>=0.0.3 <0.1.0`), because a new minor can add required handlers. `pnpm lint` enforces it with `antelopejs-check-interface-ranges`.
- When a dependency range changes, update the compatibility table in `README.md` too.
- A release that needs action from users gets an `### Upgrade notes` section in `CHANGELOG.md`, above the generated entries.

## Tests

- README "Contributing" owns the Node floor and the `PG_TEST_URL` safety rule; read it before running database tests. CI runs only the `.nvmrc` version.
- `pnpm test` (and so `pnpm run checks`) builds `dist` once, then runs `ajs module test .` with the test project in `src/test/antelope.test.ts`: every suite in `dist/test` (unit specs included) plus the shared conformance suites of the implemented interfaces. It then runs the external-mode suites in `dist/test-external` with `PG_TEST_MODE=external`. Both runs need Docker: they start a `postgres:18-alpine` container through Testcontainers unless `PG_TEST_URL` is set.
- `pnpm test:unit` runs only the database-free unit specs with Mocha; `pnpm test:external` runs only the external-mode suites. Neither is needed after `checks`, which already runs both.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

Finish every change with `pnpm run checks`. It runs typecheck, lint, format, knip, tests, size, ratchet, and sync, and prints only what failed. The change is done when it prints no failure.

The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.

### Comments

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (`/** */`) on that item. The only other comments are lint directives that name their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, `/*!` license headers, and bundler or formatter directives.

### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.

### Debt

`guardrails.ratchet.json` records the lint findings and oversize files this repository already had. Its numbers only go down. After you remove debt, run `pnpm run ratchet:update` and commit the lowered file. A rule listed there is off for `oxlint`. The ratchet counts it instead, and the pre-commit hook rejects it on every line you add.

### What enforces what

| Rule                                                                           | Enforced by                               |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| Formatting                                                                     | oxfmt                                     |
| Lint findings are errors; no rule warns                                        | oxlint preset                             |
| Comments are TSDoc, directives, or `SAFETY:` only                              | `antelopejs/no-comments`                  |
| Every test asserts                                                             | `antelopejs/require-assertion`            |
| Tests read no files outside fixtures, helpers, locales                         | `antelopejs/no-fs-read-in-tests`          |
| No assertion that restates a constant                                          | `antelopejs/no-constant-value-assertion`  |
| No test whose only check is "is a function"                                    | `antelopejs/no-typeof-function-only-test` |
| Params ≤ 5, function ≤ 120 lines, file ≤ 500 lines, depth ≤ 4, complexity ≤ 20 | `eslint/max-*`, `eslint/complexity`       |
| Files ≤ 20,000 bytes, tests included                                           | `antelopejs-check-size` (pre-commit)      |
| Existing debt only shrinks                                                     | `antelopejs-ratchet`                      |
| Types check                                                                    | `tsc` (pre-push)                          |
| No dead files, exports, or dependencies                                        | knip                                      |
| Managed files match the pack                                                   | `antelopejs-sync --check`                 |
| A test names the wrong implementation it catches                               | review; no tool                           |

<!-- antelopejs-guardrails:end -->
