# Documentation

Reference for `@antelopejs/postgres`. The [root README](../README.md) covers installing it and
getting a first query running; everything below is the detail.

|                                           |                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Storage and schema](./storage.md)        | What a registered schema becomes in the database, the field-type table, what reaches an index, and how registration converges                      |
| [Configuration](./configuration.md)       | Every option `construct` accepts                                                                                                                   |
| [Change feeds](./change-feeds.md)         | `changes()`, its ordering guarantee, its retention contract and its blind spots                                                                    |
| [Errors and refusals](./errors.md)        | Everything the module refuses, with the message it refuses by                                                                                      |
| [Behaviour worth knowing](./behaviour.md) | Things that answer rather than throw, where the answer may surprise you — including where this backend differs from the MongoDB and RethinkDB ones |

If you are choosing between backends, [Behaviour worth knowing](./behaviour.md) is the page to read:
it is the only one that records where the three disagree.
