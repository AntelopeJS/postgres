# Behaviour worth knowing

Things that answer rather than throw, where the answer may not be the one you expected.

| Behaviour | Detail |
| --- | --- |
| `getAll` cannot address a single array-valued key | An array at the top level is always read as a *key list*, since the interface supplies no marker distinguishing the two. Both other backends read it the same way |
| `lookup`'s array form does not preserve the local key's order | The elements come back in the joined table's scan order, so `["B","A"]` and `["A","B"]` both answer `["A","B"]` |
| A `Date` written under an *undeclared* key loses its type | It reads back as PostgreSQL's `timestamptz` text form rather than as a `Date`. Declare the field to keep the type |
| One `insert` call caps at roughly two to four thousand documents | The wire protocol caps a bind at 65535 parameters and the bind list is O(documents × columns). The driver's message names nothing useful. Batch in the caller |
| A duplicate `_id` **within one batch** raises | PostgreSQL will not let one statement write the same row twice; picking a winner would be inventing a rule the interface does not state |
| A declared column set to `null` holds SQL NULL; an *undeclared* key set to `null` holds a stored JSON null | A typed column cannot represent the difference between the two, and `_extra` can |
| `orderBy`, `getAll` and `between` on an *undeclared* field use jsonb's type-first ordering | There is no declared type to compare by, and no index to serve it |
| `distinct` discards the ordering ahead of it | `SELECT DISTINCT … ORDER BY <other>` is not valid SQL. Both other backends drop it too |
| A negative or unreadable `slice` bound is clamped, not counted from the end | A bare negative `LIMIT` raises and loses the whole statement |
| `get(k)` under `CROSS_INSTANCE` picks the lowest `_instance` holding the key | `_id` is unique *per instance*, so reading every instance at once makes one key name one row per instance. The same row is chosen on every call, and it is the row a subsequent delete removes |
| `update(fn)` with an *expression* body answers rows matched, where every other write answers rows modified | The modified test cannot be spelled for that one shape without evaluating the mapper twice per row |
| `match` uses PostgreSQL's regex engine | A literal pattern's `\b`, `\B` and unescaped `.` are translated to match JavaScript's meaning. Named capture groups and `\p{…}` raise rather than misbehaving quietly |

Coming from another backend:

| | |
| --- | --- |
| `avg` of an empty stream | `null` here and in the MongoDB backend; RethinkDB raises. `sum` of nothing is `0` |
| `nth` past the end | `null`, which is what the interface declares. RethinkDB raises and MongoDB answers `undefined` |
| `hasfields` on a present non-object | `false`. Both other backends raise |
| `filter(…).slice(0, 5).delete()` | Deletes five rows. The MongoDB backend discards the sort and limit and deletes every match |
