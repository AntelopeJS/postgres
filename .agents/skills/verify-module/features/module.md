---
covers:
  - src/*.ts
docs:
  - README.md
  - docs/configuration.md
  - docs/errors.md
journeys:
  - module-dev
  - config-refused
  - config-options
---

# Module

The module's lifecycle and configuration: loading as `local`, the options `construct` refuses and why, the default config, `pool` options and `schemaPrefix`.

## Sub-features

- `module-dev`: as in [smoke](smoke.md).
- `config-refused`: `ajs project dev` exits and names the reason for an unknown `mode`, a `cursorBatchSize` of zero or a fraction, a negative `changeRetentionMs`, an external instance without `url` or with owned-only options, and an owned instance whose server does not answer (the driver's `connect ECONNREFUSED host:port`: only an external instance where the catalog answers words the reason as a sentence).
- `config-options`: `antelopeJs.defaultConfig` is the documented url in `safe` mode; a `pool` option the url does not set (`application_name`) reaches every pooled connection; `schemaPrefix: "app_"` stores schema `verify-config` as `app_verify-config` and nothing else.

## How to get to it (user POV)

- The module's `config` in `antelope.config.ts`, and `ajs project dev`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" module
```

## Gotchas

- `pg` parses the url's user, password, host, port and database over the `pool` options, even a port the url leaves out, so `config-options` checks a `pool` option the url never sets.
- `statementTimeoutMs`, the cursor idle timeout and the change options other than the refusal are not asserted: no journey can observe them without a slow or stalled reader.
