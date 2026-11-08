---
covers:
  - src/implementations/database/changes.ts
  - src/implementations/database/feeds.ts
  - src/implementations/database/feed-pipeline.ts
  - src/implementations/database/listener.ts
  - src/implementations/database/reaper.ts
docs:
  - docs/change-feeds.md
journeys:
  - change-feeds
---

# Change feeds

`table.changes()` on an owned instance: the trigger-fed log and the pull-based reader.

## Sub-features

- `change-feeds`: a feed opened before the writes delivers `added`, `modified`, `modified` and `removed` in order, with `oldValue` absent on `added` and `newValue` absent on `removed`, then an `added` for a row written with `psql` while it is open; a filtered feed shows a row leaving its filter as `modified` and delivers nothing for its removal outside the filter; watching the table installs its triggers and the `__antelope.changes` log.

## How to get to it (user POV)

- `for await (const change of table.changes())` in a consumer module.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" feeds
```

## Gotchas

- The feeds live in the consumer module between two scenario requests (`globalThis.verifyFeeds`), so the `psql` write happens while they are open.
- Retention (`changeRetentionMs`) and the reaper are not driven: a stalled consumer needs minutes at the default retention.
