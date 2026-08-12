# Configuration

Every option `construct` accepts, and what each one does.

```typescript
{
    url: "postgres://postgres@localhost:5432/antelopejs",  // PostgreSQL connection string
    migrations: "safe",                 // "safe" (default) or "destructive"
    schemaPrefix: "",                   // Prefix for generated PostgreSQL schema names
    cursorBatchSize: 100,               // Rows fetched per round trip when iterating
    cursorIdleTimeoutMs: 60000,         // Idle cursors are reclaimed after this delay
    statementTimeoutMs: undefined,      // Optional per-statement timeout
    changeRetentionMs: 300000,          // How long a change event stays readable — a contract
    changeBatchSize: 256,               // Change events read per round trip
    changePollIntervalMs: 5000,         // Fallback poll; NOTIFY is the primary wakeup
    pool: {                             // Optional pg.Pool options, merged over the URL
        max: 10,
        connectionTimeoutMillis: 30000,
        idleTimeoutMillis: 30000
    }
}
```

## Details

The module uses the `pg` driver and delegates pooling to `pg.Pool`:

- `url` is passed as `connectionString`; anything in `pool` is merged over it
- The pool is opened and verified during `construct`, so a bad configuration fails at startup
  rather than on the first query
- Every pooled connection is pinned to `TimeZone = 'UTC'` and `DateStyle = 'ISO, MDY'`, so that a
  stored text value read as a date resolves the same way regardless of server settings
- `statementTimeoutMs` becomes the connection's `statement_timeout`. Schema convergence deliberately
  runs with it disabled, since one `CREATE INDEX` can legitimately outlast a per-query budget
- `migrations` controls how far registration may go — see
  [Schema convergence](./storage.md#schema-convergence)
- `schemaPrefix` is useful when several applications share one database
- `cursorBatchSize` and `cursorIdleTimeoutMs` are **refused unless they are positive safe integers**,
  where every other numeric option is taken as given. `FETCH` will not accept a bound parameter for
  its count, so `cursorBatchSize` is the one configured value that reaches SQL as text rather than
  as a parameter, and it is validated at `construct()` for that reason
- The three `change*` options are validated the same way. `changeRetentionMs` is a **contract rather
  than a tuning knob**: it is the answer to how long a consumer may stall before its feed is ended —
  see [Change feeds](./change-feeds.md)
