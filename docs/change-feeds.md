# Change feeds

A durable log plus a pull-based reader: the ordering guarantee, the retention contract, and what a
feed structurally cannot see.

`table.changes()` returns an async iterable of `{ changeType, oldValue?, newValue? }`. It must be
**iterated**, and it must be the **last** stage of a query.

```typescript
for await (const change of table.filter((d) => d.key("price").lt(100)).changes()) {
    console.log(change.changeType, change.oldValue, change.newValue);
}
```

Writes are captured by statement-level triggers into an unlogged `__antelope.changes` table, which
readers poll. Triggers are installed on a table the first time something watches it, and are never
removed — a table that was watched once costs one log row per write from then on, whoever the writer
is. Trimming the log is the job of a timer inside each connected adapter process, so a deployment
that is entirely down leaves the log to accumulate whatever else still writes to those tables. Only
one process trims per pass, however many you run.

**Ordering.** Per-row order is guaranteed: two writers to the same row serialize on its lock and so
are delivered in commit order. Across unrelated rows, delivery is in insert order. A reader consumes
only events whose transaction has settled, so nothing is skipped when two writers commit out of
order — the cost is that one long-running *writing* transaction anywhere in the database delays
delivery until it ends. A long-running read-only transaction does not.

**Delivery is at-least-once at the moment a feed opens.** The horizon a feed opens above is computed
across every backend on the server, so while any write transaction is open anywhere, a row that had
already committed can fall below it and be delivered as though it were new. Erring that way is
deliberate: the other direction opens *above* transactions that have not settled, which loses events
rather than repeating them. A consumer that cannot tolerate a repeat should compare `oldValue` and
`newValue` rather than assume every event is a change it has not seen.

**Retention is a contract.** Events older than `changeRetentionMs` (five minutes by default) are
deleted. A consumer that stalls longer than that is **ended with an error naming the events it
lost**, rather than quietly falling out of sync. A feed also ends if the server restarts, because
the log does not survive one.

**A filtered feed shows a row's whole lifetime.** The predicate is evaluated on both sides of an
event and the event is delivered if *either* matched, so you see rows entering and leaving the
filter as well as changing within it. `changeType` describes what happened to the **row**, not to
its membership, so entering and leaving are both `modified`; compare `oldValue` and `newValue` to
tell them apart.

`oldValue` and `newValue` follow the operation rather than the filter: an `added` event carries no
`oldValue` and a `removed` one no `newValue`, and the key is **absent** rather than set to
`undefined`. A `modified` event always carries both, including where one side no longer matches the
filter, which is what lets you see what a row looked like before it left.

Accepted before `changes()`: `filter`, `map`, `pluck`, `without`, `key`, `default`, `get`, `getAll`,
`between` and `lookup`. A `lookup` resolves against the other table **as of delivery**, not as of
the event. On a feed `get(k)` is the predicate alone — the lowest-`_instance` rule it carries on the
read path bounds a *relation*, and a stream of independent events has nothing for it to bound.

**A feed never times out.** A quiet table and an abandoned consumer look the same from here, both
sitting on a read that has not been answered, and a feed holds no connection to reclaim — so nothing
ends one but closing it yourself and the two losses above. A transient connection failure is retried
rather than being fatal, since re-reading from the watermark is idempotent.

**What a feed cannot see.** `TRUNCATE` fires no row triggers, and neither does a destructive
migration that rewrites a column. There is no `includeInitial` in the contract, so a consumer
building a mirror must **open the feed first, then read the table, then dedupe** — reading first
races and loses everything in between.
