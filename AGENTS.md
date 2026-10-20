# postgres

## Documentation Placement

DRY applies to prose. A stated fact — a measurement, a constraint, a reason a shape was chosen —
gets one owner, and every other site references it instead of restating it. A number restated in
four places is four places to update and three chances to be wrong, which is the same failure DRY
exists to prevent in code.

- A **private** function gets at most two lines of TSDoc.
- Anything longer goes on the module's **exported map or type**, which is where a reader looking for
  the family's reasoning arrives.
- An **exported** function documents its own contract, since its callers cannot see the module essay.

## Test safety

`PG_TEST_URL` must target a disposable PostgreSQL instance: the external suite drops and recreates a fixture database and may create a role. Without it, tests use Testcontainers by default. Read [src/test/antelope.test.ts](./src/test/antelope.test.ts) and the [package scripts](./package.json) before running database tests; `pnpm test` includes the external suite. Use `pnpm test:unit` for the database-free unit suite.

## Code conventions

- Write code, identifiers, and comments in English.
- Use pnpm for package management and repository scripts.
- Follow the repository's lint and formatting configuration.
- Prefer the smallest change that solves the task; generalize for an existing need.
- Keep functions focused. Extract helpers when they clarify a responsibility, not just to meet a line count.
- Explain non-obvious constraints and decisions in comments; avoid restating the code. Document public contracts with TSDoc.
- Use objects, maps, or arrays instead of `switch/case`.
- Use named interfaces or types instead of anonymous object types.
- Give non-obvious values named constants.
- Prefer early returns to deeply nested branches, and reuse existing logic rather than duplicating it.
- Name identifiers for their role; use boolean names such as `isActive` or `shouldRefresh`.
- In index files, prefer `export * from './module'` over named re-exports.
