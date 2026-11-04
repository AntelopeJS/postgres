---
title: Configuration
description: Every option that construct accepts in the PostgreSQL module, with its default and what it does.
mode: reference
---

Every option that `construct` accepts, and what each one does.

```typescript fragment
{
    mode: "owned",                      // "owned" (default) or "external"
    url: "postgres://postgres@localhost:5432/antelopejs",  // PostgreSQL connection string
    migrations: "safe",                 // "safe" (default) or "destructive"
    schemaPrefix: "",                   // Prefix for generated PostgreSQL schema names
    cursorBatchSize: 100,               // Rows fetched per round trip when iterating
    cursorIdleTimeoutMs: 60000,         // Idle cursors are reclaimed after this delay
    statementTimeoutMs: undefined,      // Optional per-statement timeout
    changeRetentionMs: 300000,          // How long a change event stays readable, a contract
    changeBatchSize: 256,               // Change events read per round trip
    changePollIntervalMs: 5000,         // Fallback poll; NOTIFY is the primary wakeup
    pool: {},                           // Optional pg.Pool options, merged over the URL
    catalog: {}                         // External mode only: { enabled?: boolean }
}
```

Every value above is the module's own default. `pool` is the exception. It defaults to `{}`, and every option you leave out of it keeps the default of `pg`, not one of this module's. Those defaults are `max: 10`, `idleTimeoutMillis: 10000` and `connectionTimeoutMillis: 0`. The last one waits forever.

## Details

The module uses the `pg` driver and leaves pooling to `pg.Pool`:

- The module passes `url` as `connectionString` and merges everything in `pool` over it.
- A cursor holds a pooled connection for as long as it is open, so `pool.max` is also the number of cursors that can be iterated at once. Past that, a read waits for one to finish or to be reclaimed. With the `pg` default `connectionTimeoutMillis: 0`, it waits without a deadline. Set `pool.max` above your expected concurrent iterations. Set `connectionTimeoutMillis` if a read should fail rather than block.
- `construct` opens the pool and checks one connection, so a bad configuration fails at startup, not on the first query. An external instance where the catalog answers is the exception. See [A connection that fails at startup](./external-mode.md#a-connection-that-fails-at-startup).
- Every pooled connection is pinned to `TimeZone = 'UTC'` and `DateStyle = 'ISO, MDY'`. A stored text value read as a date then resolves the same way whatever the server settings are.
- `statementTimeoutMs` becomes the connection's `statement_timeout`. Schema convergence runs with it disabled on purpose, because one `CREATE INDEX` can take longer than a per-query budget.
- `mode: "external"` serves tables that already exist in a database the module does not own. See [External mode](./external-mode.md). It refuses `schemaPrefix`, `migrations` and the three `change*` options by name, because none of them applies there. It also refuses an empty or missing `url`.
- `migrations` controls how far registration may go. See [Schema convergence](./storage.md#schema-convergence).
- `schemaPrefix` is for several applications that share one database.
- `cursorBatchSize` and `cursorIdleTimeoutMs` are refused unless they are positive safe integers. Every other numeric option is taken as given. `FETCH` does not accept a bound parameter for its count, so `cursorBatchSize` is the one configured value that reaches SQL as text and not as a parameter. That is why `construct()` validates it.
- The three `change*` options are validated the same way. `changeRetentionMs` is a contract, not a tuning value. It sets how long a consumer may stall before its feed is ended. See [Change feeds](./change-feeds.md).
- `catalog.enabled` turns the catalog of an external instance on or off. Unset, the catalog follows the project's development mode. See [The catalog](./external-mode.md#the-catalog).
