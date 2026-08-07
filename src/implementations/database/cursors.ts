import type { PoolClient } from "pg";
import { GetOptions, type ResolvedOptions } from "../../config";
import { AcquireClient, RegisterBeforeDisconnect } from "../../connection";
import type { ResultRow } from "./query";
import { QuoteIdentifier } from "./sql";

const CURSOR_NAME = QuoteIdentifier("antelopejs_cursor");
const BEGIN = "BEGIN";
const ROLLBACK = "ROLLBACK";
const CLOSE = `CLOSE ${CURSOR_NAME}`;

/** Nothing left — an empty row buffer, or a registry holding no cursor the sweep still has work for. */
const EMPTY = 0;

/** The idle timeout of a cursor that never armed a reaper, which no reclaimed cursor can be. */
const UNARMED = 0;

/**
 * How many finished cursors keep the reason they finished before the oldest is forgotten.
 *
 * An ending has to outlive the cursor it describes: a read that arrives after teardown asks why the
 * cursor stopped, and only a remembered ending can answer. It cannot outlive it forever either —
 * `reqId` is a counter that never repeats, so a registry that only grows leaks one small record per
 * cursor the process ever opened.
 *
 * Reaching this bound is ordinary rather than exotic, and the reaper is what reaches it: a consumer
 * that stops reading long enough to be reclaimed is precisely a consumer that paused, and a busy
 * process retires far more than a thousand cursors during a 60-second idle window. So the bound
 * cannot be the thing that decides what a read past it is told. `ForgottenRange` decides that, and a
 * `reqId` whose ending has been dropped is refused rather than opened.
 */
const REMEMBERED_ENDINGS = 1024;

/** Turns the driver's rows into what the caller asked for — `query.ts:DecodeRows`, bound to one relation. */
export type RowDecoder = (rows: ResultRow[]) => unknown[];

/** Where a cursor's dedicated client comes from; production never supplies one. */
export type ClientSource = () => Promise<PoolClient>;

/**
 * Everything a cursor needs to open, as the caller that compiled it already holds it.
 *
 * The statement is rendered **once** and re-used for the lifetime of the iteration (invariant 16),
 * and `params` binds against it through the extended protocol — `DECLARE … CURSOR FOR <query with
 * $n>` was measured to bind them. The batch count is the one number that cannot join them:
 * `FETCH FORWARD $1` is `42601`, so it reaches the statement as text, which is why `config.ts`
 * refuses a `cursorBatchSize` that is not a positive safe integer.
 *
 * `decode` is a row decoder and never a *result* decoder — see `query.ts:DecodeRows`, which owns
 * why the two differ here.
 *
 * `acquire` is a seam of the same kind as `DecodingContext.resolveOrigin` and for the same reason —
 * production leaves it unset and takes `connection.ts:AcquireClient`, and it exists so a spec can
 * drive the buffering, the short-batch detection, the self-reclamation and the teardown paths with
 * no server. This module's failures are leaked pool clients rather than wrong answers, which no
 * conformance assertion can see.
 *
 * **Opening is the one path that can fail while holding a client, and it rolls back before it
 * releases.** A `DECLARE` that is refused leaves the transaction aborted, and a client handed back
 * that way fails the *next unrelated query* with `25P02`, in another suite, naming nothing about the
 * cursor that broke it — one `ROLLBACK` recovers it completely. A throw on the `BEGIN` itself
 * started no transaction and releases without one, and a request that never compiled acquires
 * nothing at all.
 */
export interface CursorRequest {
  readonly sql: string;
  readonly params: unknown[];
  readonly decode: RowDecoder;
  readonly acquire?: ClientSource;
}

/** Compiles the cursor's statement, on the first read of a `reqId` and never again. */
export type CursorOpener = () => Promise<CursorRequest>;

/**
 * Why a cursor stopped, and therefore what a read arriving after it is told.
 *
 * Exhaustion, an explicit close, a failed fetch, the reaper and the disconnect sweep are five paths
 * into one teardown — clear the timer, `CLOSE`, `ROLLBACK`, release — and all five land in
 * `Teardown`, which leaves the state registered carrying the reason it ended. `CLOSE` and
 * `ROLLBACK` failures are swallowed there: the client is being discarded either way, and a throw
 * would turn a leak into a leak plus an unhandled rejection.
 *
 * **Ending exactly once is also what keeps the client from being handed back twice.** `Retire`
 * answers whether *this* call is the one that ended the state, and only that call runs the
 * sequence — the state now keeps its client reachable for the whole of the teardown, so without
 * that answer a second teardown would `release()` a client the pool has already taken back.
 *
 * **Dropping a registration is not the same as ending a cursor, and the second cannot be
 * re-derived from the first.** A state that is merely absent from the registry re-opens on the next
 * read, which acquires a second client, runs the query again and answers row 1 after `done` — the
 * first client then being reachable from nothing but its own reaper. So a state ends exactly once,
 * records why, and never opens again.
 *
 * **Ending a cursor is not the same as giving its client back either, and that is a second pair of
 * facts rather than a restatement of the first.** Teardown is two server round trips after the state
 * is marked, and `pool.end()` was measured not to resolve while a client is checked out. A sweep
 * that waited on *live* states alone would see nothing to do for the whole of that window, resolve,
 * and end the pool with a client still out. So a state keeps its client reachable until `release()`
 * has returned, the disconnect sweep waits on that fact rather than on liveness, and it is that same
 * fact `CountOpenCursors` reports — the number the specs' own leak check is built on.
 *
 * Three of the endings answer `{ done: true }`. An exhausted async iterator stays exhausted, an
 * explicitly closed one is over by request, and a failed one already raised its error to the read
 * that hit it — the same shape a generator takes, which is finished once it has thrown.
 *
 * `failed` is the weakest of the three and is recorded honestly rather than defended.
 * `IterableCursor.next()` builds a **fresh** promise with its own `resolve`/`reject` on every call,
 * so the caller that hit the failure is the caller that sees the rejection, and a `for await` never
 * re-enters after one. What remains exposed is a consumer that catches a rejected `next()` and calls
 * it again: it is answered a clean `done` over a query that errored. `done` is still the better
 * default — the error was raised once already, and re-opening would re-run the query — but the trade
 * is real, so it is written down here instead of being claimed away.
 *
 * **A reclaimed cursor throws instead**, and that asymmetry is the point. Reaping is not
 * exhaustion: answering `done` silently truncates a slow consumer's result set, and re-opening
 * silently serves it rows it has already seen, while an error naming the idle timeout is both
 * honest and the one outcome a caller can act on — the whole query is still there to be retried.
 * The abandoned consumer the reaper actually exists for never reads again and cannot tell the
 * difference.
 *
 * **A forgotten cursor throws for the same reason.** Once `REMEMBERED_ENDINGS` has dropped an
 * ending, the state that ended cannot say whether it was exhausted or reclaimed, and answering
 * `done` for what may have been a reap is exactly the silent truncation above. `ForgottenRange` is
 * what makes the distinction available at all — without it the `reqId` looks unseen and re-opens.
 */
type EndReason = "exhausted" | "closed" | "reaped" | "failed" | "forgotten";

const EXHAUSTED: EndReason = "exhausted";
const CLOSED: EndReason = "closed";
const REAPED: EndReason = "reaped";
const FAILED: EndReason = "failed";
const FORGOTTEN: EndReason = "forgotten";

interface OpenCursor {
  readonly client: PoolClient;
  readonly decode: RowDecoder;
  readonly buffer: unknown[];
  isDrained: boolean;
  timer?: NodeJS.Timeout;
}

interface CursorState {
  chain: Promise<unknown>;
  cursor?: OpenCursor;
  isOpening: boolean;
  idleTimeoutMs: number;
  reason?: EndReason;
}

/**
 * The lowest and highest `reqId` whose ending `REMEMBERED_ENDINGS` has actually dropped.
 *
 * The endings map is bounded, so an ending is eventually forgotten while its `reqId` can still come
 * back — and a `reqId` the registry has never heard of is otherwise indistinguishable from one whose
 * ending it dropped, which is the whole of the re-open hole a bound opens. This range tells them
 * apart without remembering anything per cursor: a `reqId` inside it was registered, ended, and had
 * its ending evicted, so it is refused; a `reqId` outside it at either end is genuinely new.
 *
 * **The range spans the evicted `reqId`s rather than every `reqId` ever seen**, and the difference
 * is load-bearing rather than a detail. A `reqId` is allocated when a cursor is *constructed* and
 * arrives here when it is first *read*, and nothing orders those two: constructing cursors `a` and
 * `b` and iterating `b` first makes `a`'s id interior to everything seen while `a` has never ended
 * at all. Interior to the *evicted* range, that same id would have to belong to a cursor built more
 * than a thousand endings ago and read for the first time only now — the case decision 7b already
 * accepts, rather than an ordinary pair of cursors read out of order.
 *
 * **Both ends, because the two allocators run in opposite directions.** The interface's own
 * `nextReqId` counts up from 0, and the unit specs count down from -1 precisely so that counter can
 * never reach one of their ids (invariant 15). A high-water mark alone would refuse every spec
 * cursor allocated after the first eviction.
 */
interface ForgottenRange {
  readonly lowest: number;
  readonly highest: number;
}

type EndedAnswer = (
  reqId: number,
  state: CursorState,
) => IteratorResult<unknown, void>;

const cursors = new Map<number, CursorState>();
const retired: number[] = [];

let forgotten: ForgottenRange | undefined;
let isSweeping = false;

function Ignore() {}

/** Runs a teardown step whose failure matters less than the client it is giving back. */
function Quietly(step: () => unknown): Promise<void> {
  return Promise.resolve().then(step).then(Ignore, Ignore);
}

function Done(): IteratorResult<unknown, void> {
  return { done: true, value: undefined };
}

function ReclaimedMessage(reqId: number, idleTimeoutMs: number): string {
  return `cursor ${reqId} was reclaimed after ${idleTimeoutMs} ms idle (cursorIdleTimeoutMs) and cannot be resumed; re-run the query`;
}

function Reclaimed(reqId: number, state: CursorState): never {
  throw new Error(ReclaimedMessage(reqId, state.idleTimeoutMs));
}

function ForgottenMessage(reqId: number): string {
  return `cursor ${reqId} has already ended and how it ended is no longer remembered, more than ${REMEMBERED_ENDINGS} cursors having ended since; re-run the query`;
}

function Forgotten(reqId: number): never {
  throw new Error(ForgottenMessage(reqId));
}

const ENDED_ANSWERS: Record<EndReason, EndedAnswer> = {
  [EXHAUSTED]: Done,
  [CLOSED]: Done,
  [FAILED]: Done,
  [REAPED]: Reclaimed,
  [FORGOTTEN]: Forgotten,
};

function IsLive(state: CursorState): boolean {
  return state.reason === undefined;
}

/** True while a pool client is out on this state's behalf — being acquired, held, or being given back. */
function HoldsClient(state: CursorState): boolean {
  return state.isOpening || state.cursor !== undefined;
}

/** A state the disconnect sweep still has work for: not yet ended, or ended and still holding on. */
function IsPending(state: CursorState): boolean {
  return IsLive(state) || HoldsClient(state);
}

function PendingReqIds(): number[] {
  return [...cursors.entries()]
    .filter(([, state]) => IsPending(state))
    .map(([reqId]) => reqId);
}

/** Widens the range of `reqId`s whose ending has been dropped. */
function Evicted(reqId: number) {
  forgotten = forgotten
    ? {
        lowest: Math.min(forgotten.lowest, reqId),
        highest: Math.max(forgotten.highest, reqId),
      }
    : { lowest: reqId, highest: reqId };
}

/** A `reqId` the registry no longer holds because its ending was evicted, not because it is new. */
function WasForgotten(reqId: number): boolean {
  return (
    forgotten !== undefined &&
    reqId >= forgotten.lowest &&
    reqId <= forgotten.highest
  );
}

/** Records an ending and drops the oldest; only a state that holds nothing is ever queued. */
function Forget(reqId: number) {
  retired.push(reqId);
  while (retired.length > REMEMBERED_ENDINGS) {
    const dropped = retired.shift() as number;
    cursors.delete(dropped);
    Evicted(dropped);
  }
}

/** Ends the state once and for all, answering whether this call is the one that ended it. */
function Retire(reqId: number, state: CursorState, reason: EndReason): boolean {
  if (!IsLive(state)) {
    return false;
  }
  state.reason = reason;
  if (!HoldsClient(state)) {
    Forget(reqId);
  }
  return true;
}

/** One state per `reqId` for its whole life, so no read can ever hold a state the registry replaced. */
function Registered(reqId: number): CursorState {
  const known = cursors.get(reqId);
  if (known) {
    return known;
  }
  const state: CursorState = {
    chain: Promise.resolve(),
    isOpening: false,
    idleTimeoutMs: UNARMED,
  };
  cursors.set(reqId, state);
  if (WasForgotten(reqId)) {
    Retire(reqId, state, FORGOTTEN);
  }
  return state;
}

function DeclareStatement(sql: string): string {
  return `DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${sql}`;
}

function FetchStatement(batchSize: number): string {
  return `FETCH FORWARD ${batchSize} FROM ${CURSOR_NAME}`;
}

/** Rolls the cursor's transaction off the client before the pool takes it back. */
async function Discard(client: PoolClient): Promise<void> {
  await Quietly(() => client.query(ROLLBACK));
  await Quietly(() => client.release());
}

/** Takes a client, opens the transaction and declares the cursor on it. */
async function Declare(request: CursorRequest): Promise<OpenCursor> {
  const acquire = request.acquire ?? AcquireClient;
  const client = await acquire();
  try {
    await client.query(BEGIN);
  } catch (err) {
    await Quietly(() => client.release());
    throw err;
  }
  try {
    await client.query(DeclareStatement(request.sql), request.params as never);
  } catch (err) {
    await Discard(client);
    throw err;
  }
  return {
    client,
    decode: request.decode,
    buffer: [],
    isDrained: false,
  };
}

function ClearReaper(cursor: OpenCursor) {
  if (cursor.timer) {
    clearTimeout(cursor.timer);
    cursor.timer = undefined;
  }
}

/** Closes the cursor, gives the client back and ends the state, whoever asked and however often. */
async function Teardown(
  reqId: number,
  state: CursorState,
  reason: EndReason,
): Promise<void> {
  const cursor = state.cursor;
  if (!Retire(reqId, state, reason) || !cursor) {
    return;
  }
  ClearReaper(cursor);
  await Quietly(() => cursor.client.query(CLOSE));
  await Discard(cursor.client);
  state.cursor = undefined;
  Forget(reqId);
}

/** Reclaims the cursor only if the timer that fired is still its current one; a read may have re-armed it. */
async function Expire(
  reqId: number,
  state: CursorState,
  timer: NodeJS.Timeout,
): Promise<void> {
  if (state.cursor?.timer !== timer) {
    return;
  }
  await Teardown(reqId, state, REAPED);
}

/** Queues the reclaim behind whatever the entry is already doing, so it cannot cut into a read. */
function Reap(reqId: number, state: CursorState, timer: NodeJS.Timeout) {
  state.chain = state.chain
    .then(() => Expire(reqId, state, timer))
    .then(Ignore, Ignore);
}

/** Arms the idle reclaim; the timer is `unref`'d so it cannot hold the event loop open. */
function ArmReaper(
  reqId: number,
  state: CursorState,
  cursor: OpenCursor,
  idleTimeoutMs: number,
) {
  const timer = setTimeout(() => Reap(reqId, state, timer), idleTimeoutMs);
  timer.unref();
  cursor.timer = timer;
  state.idleTimeoutMs = idleTimeoutMs;
}

/** One round trip; a batch shorter than the count asked for is the end of the cursor. */
async function FetchBatch(
  cursor: OpenCursor,
  batchSize: number,
): Promise<void> {
  const fetched = await cursor.client.query<ResultRow>(
    FetchStatement(batchSize),
  );
  cursor.isDrained = fetched.rows.length < batchSize;
  for (const value of cursor.decode(fetched.rows)) {
    cursor.buffer.push(value);
  }
}

async function Refill(
  reqId: number,
  state: CursorState,
  cursor: OpenCursor,
  batchSize: number,
): Promise<void> {
  try {
    await FetchBatch(cursor, batchSize);
  } catch (err) {
    await Teardown(reqId, state, FAILED);
    throw err;
  }
}

/** Holds the acquiring flag across the whole open, so the sweep can see a client on its way out. */
async function Opened(
  state: CursorState,
  open: CursorOpener,
): Promise<OpenCursor> {
  state.isOpening = true;
  try {
    return await Declare(await open());
  } finally {
    state.isOpening = false;
  }
}

async function Established(
  reqId: number,
  state: CursorState,
  open: CursorOpener,
): Promise<OpenCursor> {
  if (state.cursor) {
    return state.cursor;
  }
  try {
    const cursor = await Opened(state, open);
    state.cursor = cursor;
    return cursor;
  } catch (err) {
    Retire(reqId, state, FAILED);
    throw err;
  }
}

async function Advance(
  reqId: number,
  state: CursorState,
  open: CursorOpener,
  options: ResolvedOptions,
): Promise<IteratorResult<unknown, void>> {
  if (isSweeping) {
    await Teardown(reqId, state, CLOSED);
  }
  if (state.reason) {
    return ENDED_ANSWERS[state.reason](reqId, state);
  }
  const cursor = await Established(reqId, state, open);
  ClearReaper(cursor);
  if (cursor.buffer.length === EMPTY && !cursor.isDrained) {
    await Refill(reqId, state, cursor, options.cursorBatchSize);
  }
  if (cursor.buffer.length === EMPTY) {
    await Teardown(reqId, state, EXHAUSTED);
    return Done();
  }
  ArmReaper(reqId, state, cursor, options.cursorIdleTimeoutMs);
  return { done: false, value: cursor.buffer.shift() };
}

/**
 * Answers one element of the cursor named by `reqId`, opening it through `open` if it is unknown.
 *
 * Every read on one `reqId` is chained onto the last, the open included. node-postgres serializes
 * queries on a client, so the wire is never corrupted, but two overlapping reads would both observe
 * an empty buffer, both fetch, and interleave the rows they shift — and two overlapping *first*
 * reads would open two cursors and leak the client of whichever lost the registration. The
 * consumer's `next()` prevents neither.
 *
 * Chaining orders those reads; it does not end them. A read can still arrive on a cursor that is
 * already gone — a fourth `next()` on a two-row cursor, a `next()` issued while `CloseCursor` is in
 * flight, a read racing the disconnect sweep, or one on a `reqId` whose ending is old enough to have
 * been forgotten — so a cursor that has stopped stays stopped and answers from how it stopped.
 * `EndReason` carries which answer and why, and the two that throw are the reclaimed cursor and the
 * forgotten one.
 *
 * A batch shorter than the configured count means the cursor is exhausted, so the last element is
 * answered without a further round trip and the element after it tears the cursor down. Nothing
 * asks for that: the contract's own suite iterates to completion and never closes, so self-reclaim
 * is the only thing between this adapter and one leaked pool client per iteration.
 *
 * The options are read here, synchronously, rather than inside the machinery, so that a spec can
 * drive a cursor through a temporary configuration without the set outliving the call (invariant 7).
 */
export function ReadCursorRow(
  reqId: number,
  open: CursorOpener,
): Promise<IteratorResult<unknown, void>> {
  const options = GetOptions();
  const state = Registered(reqId);
  const next = state.chain.then(() => Advance(reqId, state, open, options));
  state.chain = next.then(Ignore, Ignore);
  return next;
}

/**
 * Closes the cursor named by `reqId`, behind whatever read is still in flight on it.
 *
 * Total, as the contract requires: it is called for a `reqId` that never opened, and twice for one
 * that did, and it neither throws nor rejects on either. The chaining is not tidiness — this is the
 * path `IterableCursor.return()` takes when a `for await` breaks in the middle of a `next()`, so
 * the read it has to wait for is usually still on the wire. Waiting on the chain is also what makes
 * this the sweep's one primitive: a teardown another path already started is itself on the chain, so
 * a close behind it resolves only once that teardown has released.
 *
 * **A close for a `reqId` that never opened registers it and ends it, rather than doing nothing.**
 * Nothing orders a close against a first read — `IterableCursor.return()` on a cursor that was
 * built and never iterated arrives here first — and a `reqId` left unregistered still looks new to
 * the next read, which opens it: a client acquired, the query declared and row 0 served *after* the
 * consumer closed the iterator. It is decision 7b's shape one step earlier, an ending that has to
 * be remembered because the `reqId` can come back, and it costs one entry in the endings map and no
 * client at all.
 */
export function CloseOneCursor(reqId: number): Promise<void> {
  const state = Registered(reqId);
  const closed = state.chain.then(() => Teardown(reqId, state, CLOSED));
  state.chain = closed.then(Ignore, Ignore);
  return closed;
}

/**
 * Closes every open cursor, and is registered to run before the pool is ended.
 *
 * `pool.end()` was measured not to resolve while a client is checked out, so a cursor left open
 * hangs `destroy()` and the `Disconnect()` inside `Connect()` alike. It acquires nothing — every
 * entry it walks already holds its client, or is about to give it back (invariant 9).
 *
 * A snapshot of the registry is not enough on its own: a read arriving while the sweep runs would
 * register after the snapshot was taken and open a client that nothing then closes, which is
 * `pool.end()` hanging on a client checked out during the very sweep that exists to prevent it. So
 * the sweep latches, every read that starts while it is latched ends its cursor instead of opening
 * one, and the loop runs until nothing is left pending.
 *
 * **Pending, not live.** A state marked ended is still two round trips away from having released,
 * and a sweep that filtered on liveness would step straight over it and end the pool underneath a
 * checked-out client — the same hang, reached from a self-reclaim, an explicit close or a reap
 * instead of from an untouched cursor.
 */
export async function CloseAllCursors(): Promise<void> {
  isSweeping = true;
  try {
    let pending = PendingReqIds();
    while (pending.length > EMPTY) {
      await Promise.all(pending.map((reqId) => CloseOneCursor(reqId)));
      pending = PendingReqIds();
    }
  } finally {
    isSweeping = false;
  }
}

/**
 * How many cursors hold a pool client, are acquiring one, or are giving one back.
 *
 * The question is "what is checked out", which is the only question this module's failures show up
 * in, so a cursor counts from the moment its open starts until its `release()` has returned —
 * including the whole of a teardown, which is marked ended long before the client is back.
 */
export function CountOpenCursors(): number {
  return [...cursors.values()].filter(HoldsClient).length;
}

RegisterBeforeDisconnect(CloseAllCursors);
