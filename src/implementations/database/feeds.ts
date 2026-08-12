import type { Changes } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";
import { GetOptions, type ResolvedOptions } from "../../config";
import { Query, RegisterBeforeDisconnect } from "../../connection";
import { Logger } from "../../logger";
import {
  type ChangeOperation,
  EPOCH_COLUMN,
  HIGH_WATER_COLUMN,
  LOG,
  LOG_INSTANCE_COLUMN,
  NEW_ROW_COLUMN,
  OLD_ROW_COLUMN,
  OP_COLUMN,
  REAPED,
  SCHEMA_COLUMN,
  SEQ_COLUMN,
  TABLE_COLUMN,
  TXID_COLUMN,
} from "./changes";
import type { TableShape } from "./fields";
import { SchemaName, TableName } from "./identifier";
import { EnsureListening, SubscribeToChanges } from "./listener";
import { EnsureTriggers } from "./migrate";
import { DecodeRow } from "./result";
import { GetTableShape, WaitForSchemaReady } from "./schema";
import { DEFAULT_INSTANCE_ID, type QueryStage } from "./utils";

/** A physical row as the log stored it, keyed by column rather than by field (invariant 8). */
type LoggedRow = Record<string, unknown>;

interface LoggedEvent {
  op: ChangeOperation;
  old: LoggedRow | null;
  new: LoggedRow | null;
}

interface PollRow {
  epoch: Date;
  high_water: string | null;
  scanned_to: string | null;
  events: LoggedEvent[];
}

/** What a feed watches: the physical names the trigger wrote, and the instance it is scoped to. */
export interface FeedTarget {
  readonly schemaId: string;
  readonly tableId: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly instance: string | typeof CROSS_INSTANCE;
}

/**
 * Why a feed stopped, and therefore what a read arriving after it is told.
 *
 * Two of the three are errors, and that is the whole point of the sub-plan: a feed that lost events
 * and keeps going is lying, and both causes are **silent in the database** — nothing errors, the
 * reads simply stop returning things that used to exist.
 *
 * `closed` is not a failure. An orderly `CloseCursor`, and `Disconnect`'s sweep, are endings rather
 * than losses, so they resolve `{done: true}` the way an exhausted cursor does.
 */
type EndReason = "closed" | "lapsed" | "restarted";

const CLOSED: EndReason = "closed";
const LAPSED: EndReason = "lapsed";
const RESTARTED: EndReason = "restarted";

const ADDED: ChangeOperation = "added";
const REMOVED: ChangeOperation = "removed";

const EMPTY = 0;
const NO_EVENTS = "0";

const INSTANCE_PARAM = 3;

const POLL_FAILED =
  "a PostgreSQL change feed's poll failed and will be retried";

/**
 * Where a feed's two statements are run; production never supplies one.
 *
 * The same seam `cursors.ts:ClientSource` is, and for a sharper version of the same reason:
 * **none of this module's failure modes are reachable from the conformance suite.** A lost event, a
 * lapsed watermark and a restarted server are all invisible to a board that runs in seconds against
 * a server that never restarts, so a spec has to be able to state them. It rides on the state
 * rather than on module scope, so a spec's seam cannot outlive its own call (invariant 7).
 */
export type FeedReader = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: PollRow[] }>;

/**
 * Everything a feed reaches outside itself, injected as one **named** object.
 *
 * Named rather than positional for `Compilers`' reason: `install` and `listen` answer the same type
 * and take compatible arguments, so swapping them still typechecks and does the wrong thing.
 *
 * Production supplies none of it. A spec supplies all of it, which is what lets the watermark, the
 * `xmin` gate, the lag ending and the restart ending be stated without a server — and they have to
 * be stated somewhere, because **the conformance suite reaches none of them**.
 */
export interface FeedEnvironment {
  read: FeedReader;
  install: (schemaId: string, tableId: string) => Promise<void>;
  shape: (schemaId: string, tableId: string) => TableShape;
  listen: () => Promise<void>;
}

const LIVE: FeedEnvironment = {
  read: (sql, params) => Query<PollRow>(sql, params),
  install: EnsureTriggers,
  shape: GetTableShape,
  listen: EnsureListening,
};

/** The range of `seq` a lapsed feed was promised and cannot be given, as the rejection names it. */
interface FeedGap {
  readonly from: bigint;
  readonly to: bigint;
}

interface FeedState {
  chain: Promise<unknown>;
  target?: FeedTarget;
  shape?: TableShape;
  watermark: bigint;
  epoch?: number;
  buffer: Changes<unknown>[];
  reason?: EndReason;
  gap?: FeedGap;
  wake?: () => void;
  env: FeedEnvironment;
}

const feeds = new Map<number, FeedState>();

let isSweeping = false;

function Ignore() {}

/**
 * The log read, the lag check and the restart check, in one round trip.
 *
 * The `xmin` gate is the correctness clause and not an optimization: a `bigserial` takes its number
 * when a row is *inserted* and the row becomes visible when its transaction *commits*, so under
 * concurrency those orders differ and a bare `seq > watermark` advances past a row that had not
 * committed yet — permanently, and with nothing to observe. Consuming only rows whose transaction
 * has settled is what makes `seq` order safe to advance over.
 *
 * The high-water is read **for the current epoch only**. A high-water recorded before the log's
 * sequence restarted describes a different sequence, and comparing a watermark against it would
 * reject every feed opened after a restart for a gap that never happened (invariant 26).
 */
function PollSql(instanced: boolean, limit: number): string {
  const scope = instanced
    ? ` AND ${LOG_INSTANCE_COLUMN} = $${INSTANCE_PARAM}`
    : "";
  const watermark = instanced ? "$4" : "$3";
  return `WITH "scanned" AS (
  SELECT ${SEQ_COLUMN}, ${OP_COLUMN}, ${OLD_ROW_COLUMN}, ${NEW_ROW_COLUMN}
    FROM ${LOG}
   WHERE ${SCHEMA_COLUMN} = $1 AND ${TABLE_COLUMN} = $2${scope}
     AND ${SEQ_COLUMN} > ${watermark}::bigint
     AND ${TXID_COLUMN} < pg_snapshot_xmin(pg_current_snapshot())
   ORDER BY ${SEQ_COLUMN}
   LIMIT ${limit}
)
SELECT
  pg_postmaster_start_time() AS "epoch",
  (SELECT ${HIGH_WATER_COLUMN} FROM ${REAPED}
    WHERE ${EPOCH_COLUMN} = pg_postmaster_start_time()) AS "high_water",
  (SELECT max(${SEQ_COLUMN})::text FROM "scanned") AS "scanned_to",
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'op', "s".${OP_COLUMN},
      'old', "s".${OLD_ROW_COLUMN},
      'new', "s".${NEW_ROW_COLUMN}) ORDER BY "s".${SEQ_COLUMN})
    FROM "scanned" "s"), '[]'::jsonb) AS "events"`;
}

/**
 * The `seq` a feed opens above, so it delivers what happens next and not what already did.
 *
 * **Both terms are needed, and the second is the one a reasonable implementation omits.** The
 * highest settled `seq` is where the log is now — but on a log the reaper has already emptied there
 * is no such row, and a feed opening at 0 would sit below the recorded high-water and reject itself
 * for a gap it could not possibly have missed. That is not an exotic case: it is *every* feed opened
 * on any deployment old enough to have reaped once. Opening above both is what makes "I have missed
 * nothing" true at the moment it is claimed.
 *
 * `GREATEST` ignores NULL, which is what the reaped side needs: no row for the current epoch means
 * nothing has been reaped from *this* sequence, and the log's own maximum is then the whole answer.
 */
const OPEN_SQL = `SELECT
  pg_postmaster_start_time() AS "epoch",
  GREATEST(
    (SELECT COALESCE(max(${SEQ_COLUMN}), ${NO_EVENTS}) FROM ${LOG}
      WHERE ${TXID_COLUMN} < pg_snapshot_xmin(pg_current_snapshot())),
    (SELECT ${HIGH_WATER_COLUMN} FROM ${REAPED}
      WHERE ${EPOCH_COLUMN} = pg_postmaster_start_time())
  )::text AS "scanned_to"`;

function Named(state: FeedState): string {
  const target = state.target as FeedTarget;
  return `${target.schemaId}.${target.tableId}`;
}

/** Names the range that went, which is the whole reason the reaper records a high-water at all. */
function LapsedMessage(state: FeedState): string {
  const gap = state.gap as FeedGap;
  return `change feed on '${Named(state)}' fell behind the retention window (changeRetentionMs): events ${gap.from} through ${gap.to} were reaped before it read them, so it cannot continue; re-open the feed`;
}

function RestartedMessage(state: FeedState): string {
  return `change feed on '${Named(state)}' cannot continue: the PostgreSQL server restarted, and the change log does not survive a restart, so every event it had not read is lost; re-open the feed`;
}

const ENDED_MESSAGES: Record<EndReason, (state: FeedState) => string> = {
  [CLOSED]: () => "",
  [LAPSED]: LapsedMessage,
  [RESTARTED]: RestartedMessage,
};

function Registered(reqId: number, env?: FeedEnvironment): FeedState {
  const known = feeds.get(reqId);
  if (known) {
    return known;
  }
  const state: FeedState = {
    chain: Promise.resolve(),
    watermark: 0n,
    buffer: [],
    env: env ?? LIVE,
  };
  feeds.set(reqId, state);
  return state;
}

export function IsRegisteredFeed(reqId: number): boolean {
  return feeds.has(reqId);
}

/** Ends the feed once, and releases whatever read is waiting on it. */
function Retire(state: FeedState, reason: EndReason) {
  if (!state.reason) {
    state.reason = reason;
  }
  Wake(state);
}

function Wake(state: FeedState) {
  const waiting = state.wake;
  state.wake = undefined;
  waiting?.();
}

/** Resolves on a notification for this feed, on the fallback interval, or on the feed ending. */
function Waited(state: FeedState, options: ResolvedOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state.wake = undefined;
      resolve();
    }, options.changePollIntervalMs);
    timer.unref();
    state.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function Announced(target: FeedTarget): string {
  return `${target.schemaName}.${target.tableName}`;
}

/** A notification names one physical table; an absent payload is a reconnect asking everyone to catch up. */
function Notified(payload?: string) {
  for (const state of feeds.values()) {
    if (!payload || (state.target && Announced(state.target) === payload)) {
      Wake(state);
    }
  }
}

SubscribeToChanges(Notified);

function Document(
  row: LoggedRow | null,
  shape: TableShape,
): Record<string, unknown> | undefined {
  return row ? DecodeRow(row, shape) : undefined;
}

/**
 * One logged event as the contract's `Changes<T>`.
 *
 * The document is assembled by `result.ts:DecodeRow` — the read path's **own** row decoder, given
 * the physical row the log stored — which is what makes a feed's document equal to a read's by
 * construction rather than by test. It works unchanged because a logged row is keyed by physical
 * column exactly as a driver row is; the values arrive out of jsonb rather than out of typed
 * columns, and `ReviveValue` is what already reconciles that, turning a stored timestamp back into
 * a `Date`.
 *
 * The absent side is left off rather than set to `undefined`, because `oldValue` and `newValue` are
 * optional on the contract and an `added` event has no previous value to describe.
 */
function Delivered(event: LoggedEvent, shape: TableShape): Changes<unknown> {
  const change: Changes<unknown> = { changeType: event.op };
  if (event.op !== ADDED) {
    change.oldValue = Document(event.old, shape);
  }
  if (event.op !== REMOVED) {
    change.newValue = Document(event.new, shape);
  }
  return change;
}

function PollParams(target: FeedTarget, watermark: bigint): unknown[] {
  const scope =
    target.instance === CROSS_INSTANCE ? [] : [target.instance as string];
  return [target.schemaName, target.tableName, ...scope, watermark.toString()];
}

function Lapsed(state: FeedState, high: string | null): boolean {
  if (high === null) {
    return false;
  }
  return state.watermark < BigInt(high);
}

/**
 * One poll: read what settled, check nothing was lost, and buffer what arrived.
 *
 * The watermark advances to the highest `seq` **scanned**, not the highest delivered. Nothing
 * filters yet, so the two are the same today — the rule is established here because sub-plan 13 is
 * where getting it wrong shows, as a busy table with a narrow filter starving its own feed, and by
 * then this code is already written.
 */
async function Poll(state: FeedState, options: ResolvedOptions): Promise<void> {
  const target = state.target as FeedTarget;
  const shape = state.shape as TableShape;
  const result = await state.env.read(
    PollSql(target.instance !== CROSS_INSTANCE, options.changeBatchSize),
    PollParams(target, state.watermark),
  );
  const row = result.rows[0];
  if (row.epoch.getTime() !== state.epoch) {
    Retire(state, RESTARTED);
    return;
  }
  if (Lapsed(state, row.high_water)) {
    state.gap = {
      from: state.watermark + 1n,
      to: BigInt(row.high_water as string),
    };
    Retire(state, LAPSED);
    return;
  }
  for (const event of row.events) {
    state.buffer.push(Delivered(event, shape));
  }
  if (row.scanned_to !== null) {
    state.watermark = BigInt(row.scanned_to);
  }
}

const ROOT_LENGTH = 3;

function RootId(stages: QueryStage[], index: number): string {
  const id = stages[index]?.options?.id;
  return typeof id === "string" ? id : "";
}

/** The feed's target, refusing any stage between the root and `changes` by name. */
function TargetOf(stages: QueryStage[]): FeedTarget {
  const between = stages.slice(ROOT_LENGTH, stages.length - 1);
  if (between.length > EMPTY) {
    throw new Error(
      `The '${between[0].stage}' stage is not supported before 'changes' by the PostgreSQL backend yet`,
    );
  }
  const schemaId = RootId(stages, 0);
  const tableId = RootId(stages, 2);
  const supplied = stages[1]?.options?.id;
  const instance =
    supplied === CROSS_INSTANCE
      ? CROSS_INSTANCE
      : ((supplied as string | undefined) ?? DEFAULT_INSTANCE_ID);
  return {
    schemaId,
    tableId,
    schemaName: SchemaName(schemaId),
    tableName: TableName(tableId),
    instance,
  };
}

/**
 * Opens the feed: install the triggers, take a watermark, and start listening.
 *
 * The watermark is the highest **settled** `seq` in the whole log rather than the highest in this
 * table, and it is gated on `xmin` for the same reason every poll is: an in-flight transaction that
 * has already taken a number would otherwise be skipped over the moment it commits.
 *
 * The listener is awaited rather than started in the background, because the window between a feed
 * opening and its `LISTEN` landing is a window in which a notification is missed — costing a whole
 * fallback interval to notice a write that had already happened, which is longer than the contract's
 * own suite waits.
 */
async function Open(state: FeedState, stages: QueryStage[]): Promise<void> {
  const target = TargetOf(stages);
  await WaitForSchemaReady(target.schemaId);
  await state.env.install(target.schemaId, target.tableId);
  const opened = await state.env.read(OPEN_SQL, []);
  state.target = target;
  state.shape = state.env.shape(target.schemaId, target.tableId);
  state.epoch = opened.rows[0].epoch.getTime();
  state.watermark = BigInt(opened.rows[0].scanned_to ?? NO_EVENTS);
  await state.env.listen();
}

function Ended(state: FeedState): IteratorResult<unknown, void> {
  const reason = state.reason as EndReason;
  if (reason === CLOSED) {
    return { done: true, value: undefined };
  }
  throw new Error(ENDED_MESSAGES[reason](state));
}

/**
 * Answers one event, waiting for as long as it takes.
 *
 * A read that finds nothing does not resolve — it waits for a notification, for the fallback
 * interval, or for the feed to end. A feed on a quiet table and an abandoned feed are
 * indistinguishable, both sitting on an unanswered read, so there is deliberately no timer that
 * ends either: a cursor's idle reaper exists because a cursor holds a pool client, and a feed holds
 * a watermark in JS and nothing else.
 *
 * A transient failure is retried rather than being terminal, which inverts the cursor's rule for
 * the same reason. Re-reading from the watermark is idempotent, so a connection blip costs a feed
 * latency where it costs a cursor its transaction and therefore its life.
 */
async function Advance(
  state: FeedState,
  stages: QueryStage[],
  options: ResolvedOptions,
): Promise<IteratorResult<unknown, void>> {
  if (isSweeping) {
    Retire(state, CLOSED);
  }
  for (;;) {
    if (state.reason) {
      return Ended(state);
    }
    if (state.buffer.length > EMPTY) {
      return { done: false, value: state.buffer.shift() };
    }
    if (!state.target) {
      await Open(state, stages);
      continue;
    }
    await Poll(state, options).catch((err: unknown) => {
      Logger.Warn(POLL_FAILED, err);
    });
    if (state.buffer.length === EMPTY && !state.reason) {
      await Waited(state, options);
    }
  }
}

/**
 * Answers one event of the feed named by `reqId`, opening it on the first read.
 *
 * Every read on one `reqId` is chained onto the last, the open included, for `cursors.ts`'
 * reason: two overlapping reads would both poll from the same watermark, deliver the same events
 * twice and advance it once. The consumer's `next()` prevents neither.
 *
 * The options are read here, synchronously, so a spec can drive a feed through a temporary
 * configuration without the set outliving the call (invariant 7).
 */
export function ReadFeedEvent(
  reqId: number,
  stages: QueryStage[],
  env?: FeedEnvironment,
): Promise<IteratorResult<unknown, void>> {
  const options = GetOptions();
  const state = Registered(reqId, env);
  const next = state.chain.then(() => Advance(state, stages, options));
  state.chain = next.then(Ignore, Ignore);
  return next;
}

/**
 * Closes the feed named by `reqId`, behind whatever read is still in flight on it.
 *
 * Total, as the contract requires, and deliberately **not** chained the way a cursor's close is: a
 * feed's pending read may be waiting indefinitely on a quiet table, so a close that queued behind
 * it would never run. Ending the state and waking the waiter is what lets that read resolve.
 */
export function CloseOneFeed(reqId: number): Promise<void> {
  const state = feeds.get(reqId);
  if (state) {
    Retire(state, CLOSED);
  }
  return Promise.resolve();
}

/**
 * Ends every feed, and is registered to run before the pool is ended.
 *
 * A feed holds no pool client, so this is not `cursors.ts`' leak sweep — it exists so an abandoned
 * feed's pending read resolves `{done: true}` instead of being left suspended forever, and so a
 * read starting during the sweep ends rather than opening a connection the teardown will not wait
 * for. Teardown is an ending, not a loss, which is why it resolves rather than rejects.
 */
export async function CloseAllFeeds(): Promise<void> {
  isSweeping = true;
  try {
    for (const state of feeds.values()) {
      Retire(state, CLOSED);
    }
    await Promise.resolve();
  } finally {
    isSweeping = false;
  }
}

export function CountOpenFeeds(): number {
  return [...feeds.values()].filter((state) => !state.reason).length;
}

RegisterBeforeDisconnect(CloseAllFeeds);
