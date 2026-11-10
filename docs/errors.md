---
title: Errors and refusals
description: Every input the PostgreSQL module refuses, with the exact message it throws.
mode: reference
---

Everything this module refuses, with the message it refuses with. The module fills each placeholder in `{braces}` from what you passed. `{kind}` names what the module read a value as: `absent`, `null`, `text`, `number`, `boolean`, `date`, `list`, `record`, `proxy`, `query`, `staged`, or `opaque` for anything else, such as a bigint, a function or a `Buffer`.

## Change feeds

| What you did                                            | Message                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Awaited a feed instead of iterating it                  | `A 'changes' feed must be the last stage of a query and must be iterated rather than awaited`                                                                                                 |
| Put a stage after `changes()`                           | same message                                                                                                                                                                                  |
| Put an ordering or aggregating stage before `changes()` | `The '{stage}' stage cannot be used before 'changes': it needs a total order or a finite relation, and a change feed is neither`                                                              |
| Stalled past the retention window                       | `change feed on '{schema}.{table}' fell behind the retention window (changeRetentionMs): events {from} through {to} were reaped before it read them, so it cannot continue; re-open the feed` |
| Kept a feed open across a server restart                | `change feed on '{schema}.{table}' cannot continue: the PostgreSQL server restarted, and the change log does not survive a restart, so every event it had not read is lost; re-open the feed` |

The refused stages are `orderBy`, `slice`, `nth`, `count`, `sum`, `avg`, `min`, `max`, `distinct`, `group`, `union` and `join`. Each is legal on the query one level out, which is why the message names the position as well as the stage.

The four writes, `insert`, `update`, `replace` and `delete`, are refused before `changes()` too, with the same message. The message's reason fits the stages above. A write is refused because it writes and a feed reads, not because it lacks a total order.

## Iterating a cursor

| What you did                                                | Message                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Read a cursor that had been idle past `cursorIdleTimeoutMs` | `cursor {reqId} was reclaimed after {ms} ms idle (cursorIdleTimeoutMs) and cannot be resumed; re-run the query`                          |
| Read a cursor whose ending is no longer remembered          | `cursor {reqId} has already ended and how it ended is no longer remembered, more than 1024 cursors having ended since; re-run the query` |

A cursor holds a pooled connection for as long as it is open, so the module reclaims a cursor that stops being read instead of letting it keep the connection. Both of these raise an error, where an exhausted or explicitly closed cursor reports that it is done. Answering `done` for a reclaimed cursor would cut your results short without a signal, and opening it again would serve rows you had already seen. The error leaves the whole query to be run again.

## Declaring a schema

| What you did                                                  | Message                                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared `_instance` or `_extra` as a field                   | `Field '{name}' on '{table}' uses a reserved column name (_instance, _extra)`                                                                                           |
| Declared `_id` as anything but `string`                       | `Field '_id' on '{table}' restates the adapter's key column and must be declared 'string'`                                                                              |
| Used an unrecognised type token                               | `Unsupported field type '{token}' for '{path}'. Supported: string, number, boolean, date, object, any, optionally suffixed with [], a nested record, or an io-ts codec` |
| Declared an array with more than one element type             | `Field '{path}' must declare exactly one element type, received {n}`                                                                                                    |
| Two fields that truncate to the same column name              | `Fields '{a}' and '{b}' on '{table}' both map to column '{column}'; rename one`                                                                                         |
| Two tables or indexes that truncate to the same name          | `The physical name '{name}' is claimed by both {a} and {b}; rename one`                                                                                                 |
| Declared a `unique` `multi` index over an array field         | `Index '{indexId}' on table '{table}' is unique and multi over an array field, whose elements PostgreSQL cannot hold unique; drop one of the two flags`                 |
| Indexed a reserved column                                     | `Index '{indexId}' keys on '{field}', which is a reserved column the adapter owns; index a declared field instead`                                                      |
| Changed a declared type under `migrations: "safe"`            | `Column '{name}' on {table} is {actual} but the schema declares {declared}; set migrations: "destructive" to alter it`                                                  |
| Pointed the adapter at a pre-existing table it did not create | `Table {target} has no '{column}' column and one cannot be added without a default, so the table was not created by this adapter; rename it or drop it`                 |

## Selecting rows

| What you did                                               | Message                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Named an index that does not exist                         | `Unknown index '{indexId}' on '{schema}.{table}'`                                               |
| `between` on a compound index                              | `The 'between' stage ranges over one field, but '{name}' names {n}`                             |
| `between` on a field declared as an array                  | `The 'between' stage ranges over one value, but '{name}' holds a list`                          |
| `getAll` key of the wrong arity for a compound index       | `The '{indexId}' index takes a key of {n} values, received {m}`                                 |
| Used an index that keys on an array field alongside others | `The '{indexId}' index keys on an array field beside others, which no key addresses`            |
| `lookup` on a local key the schema does not declare        | `The 'lookup' stage takes its form from the local key's declared type, and '{key}' has none; …` |

`lookup` needs the declared type because it decides at compile time whether the key is a scalar or a list. An undeclared key has no type to read. A guess from the stored value could overwrite an array with a single miss, with no error.

## Writing

| What you did                                                     | Message                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `insert` after any pipeline stage                                | `The 'insert' stage does not read the rows it is applied to, so every stage before it would be discarded: {stages}`                                          |
| A write after a reshaping stage, such as `table.map(…).delete()` | `A row-mode relation must carry the origin of its table`                                                                                                     |
| Named `_extra` in a payload                                      | `Payload key '{name}' is a column this adapter owns and no payload may write it`                                                                             |
| `update({})`                                                     | `The '{stage}' stage was given a payload with nothing to write: name a field to set, or set one to undefined to remove it`                                   |
| Named `_id` in a payload over many rows                          | `The '{stage}' stage was given a payload naming '_id' over a selection of many rows: address the row with get(_id) first, or leave '_id' out of the payload` |
| A mapper that returned nothing                                   | `The '{stage}' stage was given a mapper that returned nothing: return the document the rows become`                                                          |
| Wrote a non-boolean into a declared `boolean` column             | `{subject} takes a boolean or a json boolean for a boolean column, received {type}`                                                                          |
| `insert` or `replace` under `CROSS_INSTANCE`                     | `The '{stage}' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one`                   |
| A write nested inside another query                              | `The '{stage}' stage writes, so it cannot be nested inside another query`                                                                                    |
| A write read through a cursor                                    | `The '{stage}' stage writes, so it cannot be read through a cursor`                                                                                          |
| An inserted document whose `_id` is not a string                 | `An inserted document's '_id' must be a string, received {kind}`                                                                                             |

### Duplicate keys

A write that would give a second row of an instance the key of a unique index throws the interface's `DuplicateKeyError`. Recognize it with `IsDuplicateKeyError(error)`.

| What you did                                                        | `index`          | `fields`                      |
| ------------------------------------------------------------------- | ---------------- | ----------------------------- |
| `insert` of an `_id` the instance already holds, without `conflict` | `"_id"`          | `["_id"]`                     |
| `insert`, `update` or `replace` clashing on an index `unique: true` | the index's name | its `fields`, or `[the name]` |

Under `conflict: "update"` or `"replace"`, an existing `_id` is upserted, not refused. A clash on a unique secondary index is still refused. A batch `insert` is one statement, so a duplicate anywhere in it stores none of its rows.

`replace({})` is not refused. It clears every column it does not name, so it is a well-formed statement that empties the row. `update({})` writes nothing at all, and the module refuses it as shown under [Writing](#writing).

Naming `_id` in an `update` or `replace` payload is allowed over a single row. There it asserts that the row you addressed carries that key.

## Grouping

| What you did                                                                                                 | Message                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `filter`, `orderBy`, `slice`, `nth`, `join`, `lookup`, `union` or a nested `group` inside a `group` callback | `The '{stage}' stage cannot appear in a group's sub-stream, though it is legal on the query outside the group`        |
| Two aggregates in one sub-stream, such as `stream.count().count()`                                           | `The '{stage}' stage cannot follow an aggregate in a group's sub-stream, since an aggregate may not read another one` |

A group's callback accepts `map`, `distinct`, `count`, `sum`, `avg`, `min` and `max`.

## Instances and configuration

| What you did                                                                                                                                     | Message                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Passed `CROSS_INSTANCE` to `createInstance` or `destroyInstance`                                                                                 | `{operation} does not accept CROSS_INSTANCE: pass a string id or omit it for the default instance` |
| Passed a non-string instance id                                                                                                                  | `{operation} expects a string instance id, received {kind}`                                        |
| A `cursorBatchSize`, `cursorIdleTimeoutMs`, `changeRetentionMs`, `changeBatchSize` or `changePollIntervalMs` that is not a positive safe integer | `{option} must be a positive safe integer, received {value}`                                       |
| A `mode` other than `"owned"` or `"external"`                                                                                                    | `mode must be one of owned, external, received {mode}`                                             |
| `mode: "external"` with no `url`, or an empty one                                                                                                | `mode "external" needs a non-empty config.url; set it through the project's envOverrides`          |
| Queried with no configuration set                                                                                                                | `PostgreSQL adapter is not configured: construct() has not run yet`                                |
| Queried with no pool open                                                                                                                        | `PostgreSQL adapter is not connected: construct() has not run yet`                                 |

Both suffixes name the common cause, not the only one. `construct()` clears the configuration and leaves no pool when it fails to reach the server. A query therefore answers these messages after a failed startup too, and after `destroy()`. An external instance that started without a connection answers `PostgreSQL adapter is not connected: {reason}` instead. See [A connection that fails at startup](./external-mode.md#a-connection-that-fails-at-startup).

## External mode

See [External mode](./external-mode.md).

| What you did                                                                   | Message                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Set `schemaPrefix`, `migrations` or a `change*` option with `mode: "external"` | `{options} cannot be set with mode "external": an external instance owns no schemas, runs no DDL and keeps no change log`                                                            |
| Declared a table the database does not have                                    | `Table '{schema}.{table}' reads "{schema}"."{table}", which the database does not have`                                                                                              |
| Declared a table the connected role cannot read                                | `Table '{schema}.{table}' reads "{schema}"."{table}", which the connected role cannot SELECT from`                                                                                   |
| Declared a field its relation has no column for                                | `Field '{schema}.{table}.{field}' reads column "{field}", which "{schema}"."{table}" does not have`                                                                                  |
| Declared a type the column cannot be read as                                   | `Field '{path}' is declared {type}, but column "{column}" is {native type}: declare it as {types}`                                                                                   |
| Declared `_id` on a relation with no key                                       | `Field '{path}._id' aliases the relation's key, but "{schema}"."{table}" has no primary key and no unique index over NOT NULL columns; remove it`                                    |
| Read a named instance                                                          | `"{schema}"."{table}" is an external relation and has no instances, so instance '{id}' names nothing: read it through the default instance`                                          |
| `get`, `getAll` without an index, or `_id` named, on a relation with no key    | `"{schema}"."{table}" has no primary key and no unique index over NOT NULL columns, so its rows have no _id and cannot be read by key: filter on a field, or getAll by a field name` |
| A write to a relation with no key                                              | `"{schema}"."{table}" has no primary key and no unique index over NOT NULL columns, so its rows have no _id and cannot be read by key: …`                                            |
| `atomicMutation`                                                               | `The 'atomicMutation' stage is not supported on "{schema}"."{table}", an external relation: its contract tells a missing field from a NULL one, which a column cannot`               |
| A payload key that is not a declared field                                     | `Payload key '{key}' is not a field of '{schema}.{table}': … only its declared fields can be written`                                                                                |
| A value for a generated, identity ALWAYS or array column on `insert`           | `Field '{path}' cannot be given a value: it is {why}, which the database fills`                                                                                                      |
| `_id` and a key field disagreeing                                              | `Payload of '{schema}.{table}' claims two values for key column "{column}", through '{first}' and '{second}'`                                                                        |
| A value its column cannot hold (`ExternalWriteError`, kind `invalid`)          | `Field '{path}' cannot hold {value}: the column is {type}`, one per field, joined by `; `                                                                                            |
| `NOT NULL` (kind `missing`)                                                    | `Field '{column}' of "{schema}"."{table}" is required`                                                                                                                               |
| Unique (kind `duplicate`)                                                      | `A row of "{schema}"."{table}" already has this value of unique "{constraint}": Key (…)=(…) already exists.`                                                                         |
| Foreign key (kind `reference` or `referenced`)                                 | `A referenced row does not exist for "{constraint}" …` or `The row of … is still referenced through "{constraint}" …`                                                                |
| Check (kind `check`)                                                           | `The row breaks check "{constraint}" of "{schema}"."{table}"`                                                                                                                        |
| No grant (kind `forbidden`)                                                    | `The connected role may not write to "{schema}"."{table}": {database message}`                                                                                                       |
| `changes()`                                                                    | `changes() needs the adapter's change log, which "{schema}"."{table}" does not have: it is an external relation, and the adapter installs nothing on it`                             |
| `createInstance` or `destroyInstance`                                          | `The '{stage}' stage manages instances, and an external instance's relations have none: read them through the default instance`                                                      |

A registration error fails the whole schema, and every query on it answers the same message. No layer maps an `ExternalWriteError` to an HTTP status, so a client sees it as a failed write that carries this message.
