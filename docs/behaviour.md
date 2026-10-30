# Behaviour worth knowing

Things that answer rather than throw, where the answer may not be the one you expected.

## Reading a value

| Behaviour                                                                              | Detail                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default(undefined)` defaults to nothing rather than being refused                     | A `default` naming no value at all is a null one, so the stage is a no-op instead of an error. It is how a caller writes "answer nothing if it is not there", and both other backends read it that way                                            |
| A `default` supplies an _alternative value_, not a value of the field's type           | `key("status").eq("completed").default("pending")` substitutes a string for a boolean and is legal. A `key(name, def)` default is the other thing: it is read as the declared column's type, which is what keeps its index and its `Date` revival |
| Truthiness follows JavaScript, so `[]`, `{}` and the string `"false"` are all **true** | Only `null`, `false`, `0` and `""` are false. `NaN` and `undefined` have no JSON spelling to store                                                                                                                                                |
| `not()` on a key that is absent or of the wrong type answers **true**                  | It matches `!undefined`. A plain SQL `NOT NULL` is NULL and would drop the row from the filter that reads it                                                                                                                                      |
| `ne` counts a value that is not there as unequal to one that is                        | The row is kept. A plain `<>` is NULL whenever either side is, and would drop it. Both other backends count it the same way                                                                                                                       |

## Selecting rows

| Behaviour                                                                                  | Detail                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAll` cannot address a single array-valued key                                          | An array at the top level is always read as a _key list_, since the interface supplies no marker distinguishing the two. Both other backends read it the same way                                                                                                                                                                                        |
| A `null` key is a value, not an open bound                                                 | The interface has no spelling for an open-ended `between`, and reading `null` as one would answer a different question. On an _undeclared_ key it matches a stored JSON null; on a **declared** field it becomes SQL NULL and so matches nothing at all, including rows whose value is null — for the reason a declared null is stored as absence at all |
| `getAll` on a field declared as an array matches by _containment_                          | The key is looked for among the elements of the stored list rather than compared against the list itself. See [storage](./storage.md) for the index that serves it                                                                                                                                                                                       |
| `orderBy`, `getAll` and `between` on an _undeclared_ field use jsonb's type-first ordering | There is no declared type to compare by, and no index to serve it                                                                                                                                                                                                                                                                                        |
| Every document carries the instance it came from under `_instance`                         | Which is what lets a `CROSS_INSTANCE` read tell its rows apart. The default instance carries no key at all, matching the MongoDB backend, where a default-instance document stores a null one                                                                                                                                                            |
| `get(k)` under `CROSS_INSTANCE` picks the lowest `_instance` holding the key               | `_id` is unique _per instance_, so reading every instance at once makes one key name one row per instance. The same row is chosen on every call, and it is the row a subsequent delete removes                                                                                                                                                           |

## Shaping a stream

| Behaviour                                                                                         | Detail                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluck` keeps the nulls stored _inside_ a jsonb field, and returns `_id` only if you asked for it | `_id` is a field like any other here, which is what both other backends do                                                                                                                               |
| `without` over an _array_ removes matching **elements**, not keys                                 | `["a","b"]` without `"a"` is `["b"]`. It is not what removing a key means, but it cannot fail, so it is left to answer                                                                                   |
| `without` over a value that is neither an object nor an array answers `null`                      | Subtracting from a scalar raises in PostgreSQL and would lose the whole statement, so it is guarded rather than allowed to fail. The row survives with a null in place of the value                      |
| `distinct(field)` also _projects_ that field                                                      | `distinct("isElectric")` yields a stream of booleans rather than of documents. Without a field the relation keeps whatever it was already yielding                                                       |
| `distinct` discards the ordering ahead of it                                                      | `SELECT DISTINCT … ORDER BY <other>` is not valid SQL. Both other backends drop it too                                                                                                                   |
| Successive `orderBy` stages are stable sorts, so the **last one written wins**                    | Sort by name, then by age, and ties in age stay in name order                                                                                                                                            |
| A `slice` bound on a _stream_ is clamped; one on an _array_ counts from the end                   | `slice(-3)` over an array is the last three elements, and a fractional bound truncates toward zero. Over a stream a bare negative `LIMIT` raises and loses the whole statement, so it is clamped instead |
| `union` never deduplicates                                                                        | The interface asserts that a stream unioned with itself is twice as long. The result's type is the union of _both_ sides' declared keys, so a key only one side declares still decodes                   |

## Joins and lookups

| Behaviour                                                                                        | Detail                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lookup`'s array form does not preserve the local key's order                                    | The elements come back in the joined table's scan order, so `["B","A"]` and `["A","B"]` both answer `["A","B"]`                                                                                                          |
| `lookup`'s array form answers `[]`, never `null`, when nothing matched                           | The interface's own return type promises an array                                                                                                                                                                        |
| A `lookup` over a value that turns out to be a scalar answers `[scalar, looked]`                 | A declared jsonb field carries a shape while you control what is stored under it, so the key may not be a document at run time. It cannot fail, and the shape never claimed otherwise                                    |
| A `join` respects the ordering _key_ ahead of it, but rows tied on that key may interleave       | Nothing orders the duplicate rows a join produces. Wrapping the sort into a subselect to fix it would trade an ordering that holds for one the planner may discard                                                       |
| A `lookup` over a `pluck` matches on the **stored** column, so the other key need not be plucked | The correlation runs under the projection, which is also what keeps it on an index. A `map`, a `slice` or a `distinct` on the other query puts it back above, where the key must be among the fields the projection kept |

## Storing a value

| Behaviour                                                                                                                                                           | Detail                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A `Date` written under an _undeclared_ key loses its type                                                                                                           | It reads back as PostgreSQL's `timestamptz` text form rather than as a `Date`. Declare the field to keep the type                                                                                                              |
| A declared field set to `null` holds SQL NULL and **reads back as an absent key**; an _undeclared_ key set to `null` holds a stored JSON null and reads back as one | A typed column cannot represent the difference between a stored null and an absent value, and `_extra` can. Setting a declared field to `null` is therefore how you remove it, and `pluck` and `hasfields` agree with the read |

## Writing

| Behaviour                                                                                                  | Detail                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `insert` argument that is an array is always a **batch**, never one document                            | This is the reading every write shares. A nested array would otherwise be stored as a document keyed by its indices                                              |
| One `insert` call caps at roughly two to four thousand documents                                           | The wire protocol caps a bind at 65535 parameters and the bind list is O(documents × columns). The driver's message names nothing useful. Batch in the caller    |
| A duplicate `_id` **within one batch** raises                                                              | PostgreSQL will not let one statement write the same row twice; picking a winner would be inventing a rule the interface does not state                          |
| A payload `_instance` is _dropped_, not written and not refused                                            | It restates where the row already is, and no write moves a row between instances. Dropping it is what lets a document be read, changed and written straight back |
| A payload `_id` is an _assertion_, so naming a different row's key answers `0`                             | It states which row you believe you addressed, and never what to write. Over a selection of many rows it is refused instead                                      |
| `update(fn)` with an _expression_ body answers rows matched, where every other write answers rows modified | The modified test cannot be spelled for that one shape without evaluating the mapper twice per row                                                               |

## Atomic single-record mutations

`table.atomicMutation(id, request)` uses the atomic contract that `interface-database` added
in its 0.1.6 release; the supported range is in the README compatibility table. Antelope automatically
runs its shared real-backend conformance tests alongside this provider's SQL,
row-lock, storage, and fault tests.

The adapter places instance, identity, and the revision or scalar equality condition directly in
the target row's `WHERE` clause and uses `RETURNING` to distinguish `applied` from `not-applied`.
PostgreSQL rechecks those conditions after a competing writer releases its row lock. The generic
`filter(...).update(...)` and `filter(...).delete()` paths do not provide this guarantee: their
identity subqueries can retain stale matches after a concurrent update.

Revision updates replace supplied top-level fields and install the new revision in the same
statement. They never upsert or retry. Validation and definitive PostgreSQL error responses throw;
other dispatch failures conservatively return `unknown`, including a lost acknowledgement after
commit. Callers must reconcile unknown outcomes rather than treating them as a failed match.

An absent-only `{ kind: "missing" }` revision condition works on undeclared fields stored in
`_extra`. It does not match JSON null or an absent record. Declared SQL columns cannot distinguish
absent fields from null, so the adapter rejects missing-revision bootstrap there. String revision
conditions support declared text columns and undeclared fields. Raw inserts, reads, and filters
preserve undeclared revision tokens.

`deleteIfEqual` compares one scalar field without providing revision or no-ABA guarantees. Date
comparisons use the adapter's native typed-value conversion. Every variant requires one instance,
rejects `CROSS_INSTANCE`, and protects identity and adapter-owned fields. Immutable record IDs and
revision tokens must not be reused across record incarnations.

## Matching text

| Behaviour                                | Detail                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match` uses PostgreSQL's regex engine   | A literal pattern's `\b`, `\B` and unescaped `.` are translated to match JavaScript's meaning. Named capture groups and `\p{…}` raise rather than misbehaving quietly |
| Only a **literal** pattern is translated | A pattern computed from a value is bound as a parameter, and no compiler here has its text to rewrite. Write the pattern out to get the JavaScript reading            |

## Coming from another backend

|                                     |                                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avg` of an empty stream            | `null` here and in the MongoDB backend; RethinkDB raises. `sum` of nothing is `0`                                                                                                                                    |
| `nth` past the end                  | `null`, which is what the interface declares. RethinkDB raises and MongoDB answers `undefined`                                                                                                                       |
| `hasfields` on a present non-object | `false`. Both other backends raise                                                                                                                                                                                   |
| `filter(…).slice(0, 5).delete()`    | Deletes five rows. The MongoDB backend discards the sort and limit and deletes every match                                                                                                                           |
| A schema declaring `_id` as a field | Accepted, as `string` and no other type. It adds no column: the key column already stores it, and the declaration is dropped from the shape. Schemas written against the document-store backends commonly declare it |
