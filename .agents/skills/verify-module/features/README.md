# Feature map

One file per feature. `covers:` lists the source globs it owns, `docs:` the pages a verdict judges, and `journeys:` the journeys it runs. `pnpm exec antelopejs-verify map` checks that every user-facing file is covered.

| Feature | What the user does | Journeys |
|---|---|---|
| [module](module.md) | An app developer configures the module and starts the project; a bad config refuses to start and says why. | module-dev, config-refused, config-options |
| [schemas](schemas.md) | A consumer module declares a schema with indexes and instances, then changes it between runs. | storage-layout, migrations |
| [writes](writes.md) | A consumer module inserts, updates, replaces and deletes documents. | insert-values, update-replace-delete |
| [reads](reads.md) | A consumer module filters, sorts, joins, groups and iterates documents. | read-queries |
| [feeds](feeds.md) | A consumer module follows `changes()` on a table while it and other writers write. | change-feeds |
| [external](external.md) | The developer points an external instance at a client's database and reads and writes its rows. | external-read-write, external-registration |
| [catalog](catalog.md) | A generator describes, profiles and samples the client's database through the catalog. | catalog-describe, catalog-refused |
| [smoke](smoke.md) | The fixed journey every verdict runs: load the module and write rows read back with `psql`. | module-dev, insert-values |
