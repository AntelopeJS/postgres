---
title: Change feeds
description: How the PostgreSQL module's change feeds work, a durable log with a pull-based reader, and what that design guarantees and cannot see.
mode: explanation
---

A change feed is a durable log plus a pull-based reader. This page covers the ordering guarantee, the retention contract, and what a feed cannot see by design.

`table.changes()` returns an async iterable of `{ changeType, oldValue?, newValue? }`. You must iterate it, and it must be the last stage of a query.

```typescript fragment
for await (const change of table
  .filter((d) => d.key("price").lt(100))
  .changes()) {
  console.log(change.changeType, change.oldValue, change.newValue);
}
```

Statement-level triggers capture writes into an unlogged `__antelope.changes` table, and readers poll that table. The adapter installs the triggers on a table the first time something watches it and never removes them. From then on, a table that was watched once costs one log row per write, whoever the writer is. A timer inside each connected adapter process trims the log. A deployment that is entirely down therefore leaves the log to grow with whatever else still writes to those tables. Only one process trims per pass, however many you run.

## Ordering

Per-row order is guaranteed. Two writers to the same row serialize on its lock, so their events arrive in commit order. Across unrelated rows, delivery is in insert order. A reader consumes only events whose transaction has settled, so nothing is skipped when two writers commit out of order. The cost is that one long-running writing transaction anywhere in the database delays delivery until it ends. A long-running read-only transaction does not.

## Delivery when a feed opens

Delivery is at least once at the moment a feed opens. The horizon that a feed opens above is computed across every backend on the server. While any write transaction is open anywhere, a row that had already committed can fall below that horizon and arrive as though it were new. The adapter errs that way on purpose. The other direction opens above transactions that have not settled, which loses events instead of repeating them. A consumer that cannot accept a repeat should compare `oldValue` and `newValue`, and not assume that every event is a change it has not seen.

## Retention

Retention is a contract. The adapter deletes events older than `changeRetentionMs`, five minutes by default. A consumer that stalls longer than that is ended with an error that names the events it lost, so it never falls out of sync without a signal. A feed also ends if the server restarts, because the log does not survive a restart.

## Filtered feeds

A filtered feed shows a row's whole lifetime. The adapter evaluates the predicate on both sides of an event and delivers the event if either side matched. You see rows enter and leave the filter, as well as change within it. `changeType` describes what happened to the row, not to its membership, so entering and leaving are both `modified`. Compare `oldValue` and `newValue` to tell them apart.

`oldValue` and `newValue` follow the operation, not the filter. An `added` event carries no `oldValue` and a `removed` one no `newValue`, and the key is absent, not set to `undefined`. A `modified` event always carries both, also when one side no longer matches the filter. That is how you see what a row looked like before it left.

The stages accepted before `changes()` are `filter`, `map`, `pluck`, `without`, `key`, `default`, `get`, `getAll`, `between` and `lookup`. A `lookup` resolves against the other table as of delivery, not as of the event. On a feed, `get(k)` is the predicate alone. On the read path, `get(k)` also picks the lowest `_instance`, a rule that bounds a relation. A stream of independent events has nothing for that rule to bound.

## Feeds never time out

A quiet table and an abandoned consumer look the same to the adapter. Both sit on a read that has not been answered, and a feed holds no connection to reclaim. Only two things end a feed: you close it, or it hits one of the two losses above. The adapter retries a transient connection failure instead of ending the feed, because reading again from the watermark is idempotent.

## What a feed cannot see

`TRUNCATE` fires no row triggers, and neither does a destructive migration that rewrites a column. The contract has no `includeInitial`. A consumer that builds a mirror must open the feed first, then read the table, then remove duplicates. Reading first races the feed and loses every write in between.
