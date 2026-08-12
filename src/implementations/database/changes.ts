import { QualifiedName, SchemaName, TableName } from "./identifier";
import { QuoteIdentifier, QuoteLiteral } from "./sql";
import {
  CHANGE_LOG_TABLE,
  CHANGE_REAPED_TABLE,
  ID_COLUMN,
  INSTANCE_COLUMN,
  REGISTRY_SCHEMA,
} from "./utils";

/**
 * What happened to a row, as the log stores it.
 *
 * The three spellings are the interface's own `Changes<T>.changeType` values, so the reader hands
 * this column straight to a caller rather than mapping it. An update is `modified` whether or not
 * it crossed a filter boundary — design §10 owns why membership is not expressible here.
 */
export type ChangeOperation = "added" | "modified" | "removed";

const ADDED: ChangeOperation = "added";
const MODIFIED: ChangeOperation = "modified";
const REMOVED: ChangeOperation = "removed";

export const LOG = QualifiedName(REGISTRY_SCHEMA, CHANGE_LOG_TABLE);
export const REAPED = QualifiedName(REGISTRY_SCHEMA, CHANGE_REAPED_TABLE);

export const SEQ_COLUMN = QuoteIdentifier("seq");
export const TXID_COLUMN = QuoteIdentifier("txid");
export const CREATED_COLUMN = QuoteIdentifier("created_at");
export const SCHEMA_COLUMN = QuoteIdentifier("schema_id");
export const TABLE_COLUMN = QuoteIdentifier("table_id");
export const LOG_INSTANCE_COLUMN = QuoteIdentifier("instance");
export const OP_COLUMN = QuoteIdentifier("op");
export const OLD_ROW_COLUMN = QuoteIdentifier("old_row");
export const NEW_ROW_COLUMN = QuoteIdentifier("new_row");

export const SINGLETON_COLUMN = QuoteIdentifier("singleton");
export const HIGH_WATER_COLUMN = QuoteIdentifier("high_water");
export const EPOCH_COLUMN = QuoteIdentifier("postmaster_started_at");

/**
 * The channel every logged change is announced on, with the physical `schema.table` as the payload.
 *
 * One channel rather than one per table, and the feeds filter on the payload in JS: `pg_notify`
 * collapses duplicate `(channel, payload)` pairs within a transaction — measured — so a bulk write
 * wakes a reader once, and a hashed per-table channel name would have to fit 63 bytes for no gain
 * this adapter can currently measure.
 *
 * It is declared here rather than with the listener that will consume it because the trigger bodies
 * below are what write to it, and a listener that subscribed to a different string would go silent
 * with nothing failing (invariant 17).
 */
export const CHANGE_CHANNEL = "antelopejs_changes";

const FEED_INDEX = "changes_feed";

const ADDED_FUNCTION = "changes_added";
const MODIFIED_FUNCTION = "changes_modified";
const REMOVED_FUNCTION = "changes_removed";

const OLD_TABLE_ALIAS = QuoteIdentifier("old_table");
const NEW_TABLE_ALIAS = QuoteIdentifier("new_table");

const TRIGGER_PREFIX = "antelopejs_changes_";

const OLD_ROW = "o";
const NEW_ROW = "n";

const SCHEMA_VARIABLE = "TG_TABLE_SCHEMA";
const TABLE_VARIABLE = "TG_TABLE_NAME";

const ID = QuoteIdentifier(ID_COLUMN);
const INSTANCE = QuoteIdentifier(INSTANCE_COLUMN);

const NOTIFY = `PERFORM pg_notify(${QuoteLiteral(CHANGE_CHANNEL)}, ${SCHEMA_VARIABLE} || '.' || ${TABLE_VARIABLE});`;

function Qualified(functionName: string): string {
  return QualifiedName(REGISTRY_SCHEMA, functionName);
}

/** One trigger function body: log what the transition tables hold, announce it, stop. */
function TriggerFunction(functionName: string, insert: string): string {
  return `CREATE OR REPLACE FUNCTION ${Qualified(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
${insert}
${NOTIFY}
RETURN NULL;
END
$fn$`;
}

function LogInsert(columns: readonly string[], select: string): string {
  return `INSERT INTO ${LOG} (${[SCHEMA_COLUMN, TABLE_COLUMN, LOG_INSTANCE_COLUMN, OP_COLUMN, ...columns].join(", ")})
SELECT ${SCHEMA_VARIABLE}, ${TABLE_VARIABLE}, ${select};`;
}

const ADDED_BODY = LogInsert(
  [NEW_ROW_COLUMN],
  `${NEW_ROW}.${INSTANCE}, ${QuoteLiteral(ADDED)}, to_jsonb(${NEW_ROW}) FROM ${NEW_TABLE_ALIAS} ${NEW_ROW}`,
);

/**
 * The one place this module depends on a decision made elsewhere.
 *
 * `OLD TABLE` and `NEW TABLE` arrive as two unordered sets and are paired on `(_instance, _id)`,
 * which is a key only because **design §5 makes the primary key immutable**: `_instance` is refused
 * outright in an `update`/`replace` payload, and a payload `_id` is an identity *assertion* rather
 * than an assignment. A future change that lets either be reassigned would mispair old rows against
 * new ones silently — a wrong `old_row` on a delivered event, not an error — so the dependency is
 * named here rather than left to be rediscovered.
 */
const MODIFIED_BODY = LogInsert(
  [OLD_ROW_COLUMN, NEW_ROW_COLUMN],
  `${NEW_ROW}.${INSTANCE}, ${QuoteLiteral(MODIFIED)}, to_jsonb(${OLD_ROW}), to_jsonb(${NEW_ROW})
FROM ${NEW_TABLE_ALIAS} ${NEW_ROW}
JOIN ${OLD_TABLE_ALIAS} ${OLD_ROW} ON ${OLD_ROW}.${INSTANCE} = ${NEW_ROW}.${INSTANCE} AND ${OLD_ROW}.${ID} = ${NEW_ROW}.${ID}`,
);

const REMOVED_BODY = LogInsert(
  [OLD_ROW_COLUMN],
  `${OLD_ROW}.${INSTANCE}, ${QuoteLiteral(REMOVED)}, to_jsonb(${OLD_ROW}) FROM ${OLD_TABLE_ALIAS} ${OLD_ROW}`,
);

/**
 * The log, the reaper's high-water row, and the three trigger functions that fill the first.
 *
 * Applied by the migrator's bootstrap beside `instances.ts:REGISTRY_STATEMENTS`, and by nothing
 * else; the shape lives here because every read and write of these rows does. It carries no DML, so
 * the bootstrap's duplicate-object retry region stays free of the statements invariant 10 warns
 * about — the reaper seeds its own row on its first pass instead.
 *
 * **`changes` is `UNLOGGED` and `changes_reaped` deliberately is not.** No feed replays events from
 * before it opened, so the WAL write on every logged change buys nothing — but the sequence behind
 * an `UNLOGGED` `bigserial` is *itself* unlogged (`relpersistence = 'u'`, measured), so an unclean
 * shutdown empties the log **and restarts `seq` at 1**. A permanent high-water row is what makes
 * that observable: without it a reader holding a watermark of 5000 asks for `seq > 5000` against a
 * log counting from 1 and goes silent with nothing to see. Nothing about reading `UNLOGGED` in a
 * DDL file suggests this, which is why it is written where the keyword is.
 *
 * The rows are **physical** — `to_jsonb` of the row as stored, `_extra` unmerged and `_instance`
 * present, under column names `PgIdentifier` may have truncated. That keeps one function body
 * serving every table, keeps a row logged before an `ADD COLUMN` readable after it, and lets the
 * reader assemble the document with the read path's own machinery. Anything reading these rows must
 * resolve fields through `FieldSpec.column` and never through the logical key (invariant 8).
 */
export const CHANGE_LOG_STATEMENTS: readonly string[] = [
  `CREATE UNLOGGED TABLE IF NOT EXISTS ${LOG} (
     ${SEQ_COLUMN} bigserial PRIMARY KEY,
     ${TXID_COLUMN} xid8 NOT NULL DEFAULT pg_current_xact_id(),
     ${CREATED_COLUMN} timestamptz NOT NULL DEFAULT now(),
     ${SCHEMA_COLUMN} text NOT NULL,
     ${TABLE_COLUMN} text NOT NULL,
     ${LOG_INSTANCE_COLUMN} text NOT NULL,
     ${OP_COLUMN} text NOT NULL,
     ${OLD_ROW_COLUMN} jsonb,
     ${NEW_ROW_COLUMN} jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS ${QuoteIdentifier(FEED_INDEX)} ON ${LOG} (${SCHEMA_COLUMN}, ${TABLE_COLUMN}, ${SEQ_COLUMN})`,
  `CREATE TABLE IF NOT EXISTS ${REAPED} (
     ${SINGLETON_COLUMN} boolean PRIMARY KEY DEFAULT true CHECK (${SINGLETON_COLUMN}),
     ${HIGH_WATER_COLUMN} bigint NOT NULL,
     ${EPOCH_COLUMN} timestamptz NOT NULL
   )`,
  TriggerFunction(ADDED_FUNCTION, ADDED_BODY),
  TriggerFunction(MODIFIED_FUNCTION, MODIFIED_BODY),
  TriggerFunction(REMOVED_FUNCTION, REMOVED_BODY),
];

function TriggerSql(
  target: string,
  operation: string,
  referencing: string,
  functionName: string,
): string {
  return `CREATE OR REPLACE TRIGGER ${QuoteIdentifier(`${TRIGGER_PREFIX}${operation.toLowerCase()}`)} AFTER ${operation} ON ${target}
REFERENCING ${referencing}
FOR EACH STATEMENT EXECUTE FUNCTION ${Qualified(functionName)}()`;
}

/**
 * The three statement-level triggers that put a table's writes in the log.
 *
 * `FOR EACH STATEMENT` with transition tables rather than `FOR EACH ROW`: a 10,000-row write is one
 * trigger invocation and one insert rather than 10,000 of each, and the transition table was
 * measured to carry every row of a multi-row statement.
 *
 * `CREATE OR REPLACE TRIGGER` rather than a `pg_trigger` lookup followed by a create, which races
 * two installers against each other. It takes `ShareRowExclusiveLock` — measured — so concurrent
 * installers serialize briefly against *writers* to that table and not against readers, and every
 * install after the first is a no-op.
 *
 * Pure text: whether these have been applied is the caller's question, not this module's.
 */
export function TriggerStatements(
  schemaId: string,
  tableId: string,
): readonly string[] {
  const target = QualifiedName(SchemaName(schemaId), TableName(tableId));
  return [
    TriggerSql(
      target,
      "INSERT",
      `NEW TABLE AS ${NEW_TABLE_ALIAS}`,
      ADDED_FUNCTION,
    ),
    TriggerSql(
      target,
      "UPDATE",
      `OLD TABLE AS ${OLD_TABLE_ALIAS} NEW TABLE AS ${NEW_TABLE_ALIAS}`,
      MODIFIED_FUNCTION,
    ),
    TriggerSql(
      target,
      "DELETE",
      `OLD TABLE AS ${OLD_TABLE_ALIAS}`,
      REMOVED_FUNCTION,
    ),
  ];
}
