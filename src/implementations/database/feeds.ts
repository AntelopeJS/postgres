import type { Changes } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { ExternalFeedRefusal } from "./external-refusals";
import { ReviveValue } from "./result";
import type { SqlType } from "./types";
import { QuoteIdentifier } from "./sql";
import { EnsureTriggers } from "./migrate";
import { WaitForSchemaReady } from "./schema";
import { RegisteredOrigin } from "./selection";
import { SchemaName, TableName } from "./identifier";
import { OUTPUT_COLUMN, type TableOrigin } from "./relation";
import { DEFAULT_INSTANCE_ID, type QueryStage } from "./utils";
import { GetOptions, type ResolvedOptions } from "../../config";
import { EnsureListening, SubscribeToChanges } from "./listener";
import { Query, RegisterBeforeDisconnect } from "../../connection";
import {
  CompileFeed,
  DOC_KEY,
  type FeedPlan,
  MATCHED_KEY,
} from "./feed-pipeline";
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
import { IsString } from "./guards";

/** One side of an event as the laterals answered it: what it projects, and whether it matched. */
interface LoggedSide {
  [DOC_KEY]: unknown;
  [MATCHED_KEY]: boolean | null;
}

export interface LoggedEvent {
  op: ChangeOperation;
  old: LoggedSide;
  new: LoggedSide;
}

interface PollRow {
  epoch: Date;
  high_water: string | null;
  scanned_to: string | null;
  scanned_count: number;
  events: LoggedEvent[];
}

/** What a feed watches: the physical names the trigger wrote, and the instance it is scoped to. */
interface FeedTarget {
  readonly schemaId: string;
  readonly tableId: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly instance: string | typeof CROSS_INSTANCE;
}

/**
 * Why a feed stopped, and therefore what a read arriving after it is told.
 * `lapsed` and `restarted` are losses and raise; `closed` is an ending and resolves `done`.
 */
type EndReason = "closed" | "lapsed" | "restarted";

const CLOSED: EndReason = "closed";
const LAPSED: EndReason = "lapsed";
const RESTARTED: EndReason = "restarted";

const ADDED: ChangeOperation = "added";
const REMOVED: ChangeOperation = "removed";

const EMPTY = 0;
const NO_EVENTS = "0";

const OUTPUT = QuoteIdentifier(OUTPUT_COLUMN);

/** The settled slice of a batch, which the laterals and the presence guard both address. */
const EVENT_CTE = QuoteIdentifier("settled");
const EVENT = QuoteIdentifier("ev");

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
 * rather than on module scope, so a spec's seam cannot outlive its own call.
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
  origin: (schemaId: string, tableId: string) => TableOrigin;
  listen: () => Promise<void>;
}

const LIVE: FeedEnvironment = {
  read: (sql, params) => Query<PollRow>(sql, params),
  install: EnsureTriggers,
  origin: RegisteredOrigin,
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
  plan?: FeedPlan;
  watermark: bigint;
  epoch?: number;
  buffer: Changes<unknown>[];
  reason?: EndReason;
  gap?: FeedGap;
  wake?: () => void;
  woken: boolean;
  full: boolean;
  ending: Promise<void>;
  endNow: () => void;
  env: FeedEnvironment;
}

/** A feed whose `Open` has run, which is the only state a poll is ever made from. */
interface OpenFeed extends FeedState {
  target: FeedTarget;
  plan: FeedPlan;
}

function IsOpen(state: FeedState): state is OpenFeed {
  return state.target !== undefined && state.plan !== undefined;
}

/**
 * How many ended feeds keep their entry before the oldest is dropped.
 * No forgotten-range guard beside it: a feed that re-opens costs an object, not a pool client.
 */
const REMEMBERED_ENDINGS = 1024;

const feeds = new Map<number, FeedState>();
const retired: number[] = [];

let isSweeping = false;

function Ignore() {}

/**
 * Blanks a side whose row is not there at all — an insert has no old row and a delete no new one.
 * It lives here rather than in the lateral, whose alias a wrapping stage moves out of scope.
 */
function Present(column: string, value: string): string {
  return `(CASE WHEN ${EVENT}.${column} IS NOT NULL THEN ${value} END)`;
}

/**
 * Whether one side of an event matched, read back out of the jsonb pair its lateral answered.
 * A missing row reads `null`, and `COALESCE` is what stops it poisoning the outer disjunction.
 */
function Admitted(side: string): string {
  return `COALESCE((${side} ->> '${MATCHED_KEY}')::boolean, false)`;
}

/**
 * The log read, the lag check and the restart check, in one round trip.
 * `LIMIT` bounds rows *scanned*, the `xmin` gate admits only settled ones, the high-water is epoch-scoped.
 */
function PollSql(plan: FeedPlan, instanced: boolean, limit: number): string {
  const first = plan.params.length;
  const scope = instanced
    ? ` AND ${LOG}.${LOG_INSTANCE_COLUMN} = $${first + INSTANCE_PARAM}`
    : "";
  const watermark = `$${first + (instanced ? 4 : 3)}`;
  return `WITH "candidate" AS (
  SELECT ${LOG}.${SEQ_COLUMN} AS ${SEQ_COLUMN},
         ${LOG}.${TXID_COLUMN} AS ${TXID_COLUMN},
         ${LOG}.${OP_COLUMN} AS ${OP_COLUMN},
         ${LOG}.${OLD_ROW_COLUMN} AS ${OLD_ROW_COLUMN},
         ${LOG}.${NEW_ROW_COLUMN} AS ${NEW_ROW_COLUMN}
    FROM ${LOG}
   WHERE ${LOG}.${SCHEMA_COLUMN} = $${first + 1} AND ${LOG}.${TABLE_COLUMN} = $${first + 2}${scope}
     AND ${LOG}.${SEQ_COLUMN} > ${watermark}::bigint
   ORDER BY ${LOG}.${SEQ_COLUMN}
   LIMIT ${limit}
),
"boundary" AS (
  SELECT min(${SEQ_COLUMN}) AS "stop" FROM "candidate"
   WHERE ${TXID_COLUMN} >= pg_snapshot_xmin(pg_current_snapshot())
),
${EVENT_CTE} AS (
  SELECT "candidate".* FROM "candidate", "boundary"
   WHERE "boundary"."stop" IS NULL OR "candidate".${SEQ_COLUMN} < "boundary"."stop"
),
"scanned" AS (
  SELECT ${EVENT}.${SEQ_COLUMN} AS ${SEQ_COLUMN},
         ${EVENT}.${OP_COLUMN} AS ${OP_COLUMN},
         ${Present(OLD_ROW_COLUMN, `"o".${OUTPUT}`)} AS "old",
         ${Present(NEW_ROW_COLUMN, `"n".${OUTPUT}`)} AS "new"
    FROM ${EVENT_CTE} AS ${EVENT}
    LEFT JOIN LATERAL (${plan.oldSide}) AS "o" ON true
    LEFT JOIN LATERAL (${plan.newSide}) AS "n" ON true
)
SELECT
  pg_postmaster_start_time() AS "epoch",
  (SELECT ${HIGH_WATER_COLUMN} FROM ${REAPED}
    WHERE ${EPOCH_COLUMN} = pg_postmaster_start_time()) AS "high_water",
  (SELECT max(${SEQ_COLUMN})::text FROM "scanned") AS "scanned_to",
  (SELECT count(*)::int FROM "scanned") AS "scanned_count",
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'op', "x".${OP_COLUMN}, 'old', "x"."old", 'new', "x"."new")
      ORDER BY "x".${SEQ_COLUMN})
    FROM "scanned" "x"
   WHERE ${Admitted('"x"."old"')} OR ${Admitted('"x"."new"')}), '[]'::jsonb) AS "events"`;
}

/**
 * The `seq` a feed opens above: what happens next, with an open writer able to repeat what just did.
 * Both terms are needed — an emptied log has no row, and the high-water is the only floor left.
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
  let endNow = Ignore;
  const ending = new Promise<void>((resolve) => {
    endNow = resolve;
  });
  const state: FeedState = {
    chain: Promise.resolve(),
    watermark: 0n,
    buffer: [],
    woken: false,
    full: false,
    ending,
    endNow,
    env: env ?? LIVE,
  };
  feeds.set(reqId, state);
  return state;
}

export function IsRegisteredFeed(reqId: number): boolean {
  return feeds.has(reqId);
}

/** Records an ending and drops the oldest once the registry is over its bound. */
function Forget(reqId: number) {
  retired.push(reqId);
  while (retired.length > REMEMBERED_ENDINGS) {
    const dropped = retired.shift();
    if (dropped === undefined) {
      break;
    }
    feeds.delete(dropped);
  }
}

/** Ends the feed once, and releases whatever read is waiting on it. */
function Retire(reqId: number, state: FeedState, reason: EndReason) {
  if (!state.reason) {
    state.reason = reason;
    Forget(reqId);
  }
  state.endNow();
  Wake(state);
}

/**
 * Releases a feed that is waiting, and remembers the wakeup for one that is not.
 * Without the flag a notification landing mid-poll is dropped and the next wait runs in full.
 */
function Wake(state: FeedState) {
  state.woken = true;
  const waiting = state.wake;
  state.wake = undefined;
  waiting?.();
}

/** Resolves on a notification for this feed, on the fallback interval, or on the feed ending. */
function Waited(state: FeedState, options: ResolvedOptions): Promise<void> {
  if (state.woken) {
    state.woken = false;
    return Promise.resolve();
  }
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

/**
 * One logged event as the contract's `Changes<T>`, leaving only the revival to do here.
 * The two sides follow the operation rather than the membership, and an absent side stays absent.
 */
function Delivered(event: LoggedEvent, type: SqlType): Changes<unknown> {
  const change: Changes<unknown> = { changeType: event.op };
  if (event.op !== ADDED) {
    change.oldValue = ReviveValue(event.old[DOC_KEY], type);
  }
  if (event.op !== REMOVED) {
    change.newValue = ReviveValue(event.new[DOC_KEY], type);
  }
  return change;
}

function PollParams(target: FeedTarget, watermark: bigint): unknown[] {
  const scope = target.instance === CROSS_INSTANCE ? [] : [target.instance];
  return [target.schemaName, target.tableName, ...scope, watermark.toString()];
}

/**
 * One poll: read what settled, check nothing was lost, and buffer what arrived.
 * The watermark advances to the highest `seq` *scanned*, so a batch admitting nothing still moves it.
 */
async function Poll(
  reqId: number,
  state: OpenFeed,
  options: ResolvedOptions,
): Promise<void> {
  const { target, plan } = state;
  const result = await state.env.read(
    PollSql(plan, target.instance !== CROSS_INSTANCE, options.changeBatchSize),
    [...plan.params, ...PollParams(target, state.watermark)],
  );
  const row = result.rows[0];
  if (row.epoch.getTime() !== state.epoch) {
    Retire(reqId, state, RESTARTED);
    return;
  }
  const reaped = row.high_water === null ? undefined : BigInt(row.high_water);
  if (reaped !== undefined && state.watermark < reaped) {
    state.gap = {
      from: state.watermark + 1n,
      to: reaped,
    };
    Retire(reqId, state, LAPSED);
    return;
  }
  state.full = row.scanned_count >= options.changeBatchSize;
  for (const event of row.events) {
    state.buffer.push(Delivered(event, plan.type));
  }
  if (row.scanned_to !== null) {
    state.watermark = BigInt(row.scanned_to);
  }
}

const ROOT_LENGTH = 3;

function RootId(stages: QueryStage[], index: number): string {
  const id = stages[index]?.options?.id;
  return IsString(id) ? id : "";
}

/** The stages between the `schema`/`instance`/`table` prefix and the trailing `changes`. */
function Between(stages: QueryStage[]): QueryStage[] {
  return stages.slice(ROOT_LENGTH, stages.length - 1);
}

/** What the feed watches: the physical names the trigger wrote, and the instance it is scoped to. */
function TargetOf(stages: QueryStage[]): FeedTarget {
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
 * The watermark spans the whole log and is `xmin`-gated; the listener is awaited, not backgrounded.
 */
async function Open(state: FeedState, stages: QueryStage[]): Promise<void> {
  const target = TargetOf(stages);
  await WaitForSchemaReady(target.schemaId);
  const origin = state.env.origin(target.schemaId, target.tableId);
  if (origin.model.external) {
    throw ExternalFeedRefusal(origin.model.external);
  }
  const plan = CompileFeed(
    Between(stages),
    origin,
    `${EVENT}.${OLD_ROW_COLUMN}`,
    `${EVENT}.${NEW_ROW_COLUMN}`,
  );
  await state.env.install(target.schemaId, target.tableId);
  const opened = await state.env.read(OPEN_SQL, []);
  state.target = target;
  state.plan = plan;
  state.epoch = opened.rows[0].epoch.getTime();
  state.watermark = BigInt(opened.rows[0].scanned_to ?? NO_EVENTS);
  await state.env.listen();
}

function Ended(
  state: FeedState,
  reason: EndReason,
): IteratorResult<unknown, void> {
  if (reason === CLOSED) {
    return { done: true, value: undefined };
  }
  throw new Error(ENDED_MESSAGES[reason](state));
}

/**
 * Answers one event, waiting for as long as it takes, with a transient failure retried not fatal.
 * The poll is raced against the feed's own ending, since `pool.end()` abandons queued acquisitions.
 */
async function Advance(
  reqId: number,
  state: FeedState,
  stages: QueryStage[],
  options: ResolvedOptions,
): Promise<IteratorResult<unknown, void>> {
  if (isSweeping) {
    Retire(reqId, state, CLOSED);
  }
  for (;;) {
    if (state.reason) {
      return Ended(state, state.reason);
    }
    if (state.buffer.length > EMPTY) {
      return { done: false, value: state.buffer.shift() };
    }
    if (!IsOpen(state)) {
      await Open(state, stages);
      continue;
    }
    state.woken = false;
    await Promise.race([
      Poll(reqId, state, options).catch((err: unknown) => {
        Logger.Warn(POLL_FAILED, err);
      }),
      state.ending,
    ]);
    if (state.buffer.length === EMPTY && !state.reason && !state.full) {
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
 * configuration without the set outliving the call.
 */
export function ReadFeedEvent(
  reqId: number,
  stages: QueryStage[],
  env?: FeedEnvironment,
): Promise<IteratorResult<unknown, void>> {
  const options = GetOptions();
  const state = Registered(reqId, env);
  const next = state.chain.then(() => Advance(reqId, state, stages, options));
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
  Retire(reqId, Registered(reqId), CLOSED);
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
    for (const [reqId, state] of feeds.entries()) {
      Retire(reqId, state, CLOSED);
    }
    await Promise.resolve();
  } finally {
    isSweeping = false;
  }
}

RegisterBeforeDisconnect(CloseAllFeeds);
