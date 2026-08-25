import assert from "node:assert";
import type { DecodingContext } from "./context";
import type { FieldSpec, TableShape } from "./fields";
import { WrittenAs } from "./readings";
import type { Compiled } from "./sql";
import { IsJsonBacked, TEXT } from "./types";
import { ID_COLUMN, INSTANCE_COLUMN, RESERVED_COLUMNS } from "./utils";
import { DecodeValue } from "./value";
import { NULL_VALUE } from "./writes-shared";

/**
 * One column a payload writes, named by its column rather than by its field.
 *
 * The two differ whenever `PgIdentifier` truncated the field name, and a member is
 * not always a declared field: `_id` is a member too when the stage is keyed by it, and `_id` is
 * never in `TableShape.fields`.
 */
export interface PayloadMember {
  column: string;
  value: Compiled;
}

/**
 * A payload's keys, sorted by what the write has to do with each.
 *
 * The two removal lists are not interchangeable: `cleared` names declared columns the write sets
 * to NULL, while `removed` names undeclared keys it subtracts from the overflow document. A key
 * routed to the wrong one still compiles and still writes — it just writes to the other half of
 * the row.
 *
 * `identity` is the odd one out: it is not something the write *writes* but something the payload
 * *claims* about the row it targets — the `_id` a caller supplied, present only where the stage
 * reads one that way. A write that assigned it instead would change the identity of the row it had
 * already found.
 */
export interface PayloadSplit {
  members: PayloadMember[];
  cleared: string[];
  extra?: Compiled;
  removed: string[];
  identity?: Compiled;
}

/**
 * A payload's written members, indexed by the column each of them lands in.
 *
 * The projection the writes that fill a **fixed** column list need — `replace` names every declared
 * column and `insert` names the batch's union — where the split itself is ordered by what the
 * caller wrote. Shared so the two spell the key the same way: a member is keyed by `column` and
 * never by the field name it was declared under.
 */
export function MembersByColumn(split: PayloadSplit): Map<string, Compiled> {
  return new Map(split.members.map((member) => [member.column, member.value]));
}

/**
 * Where a supplied `_id` lands in the split, which is what the stage doing the writing decides.
 *
 * The disposition is the whole difference between the two walks, so it is the behaviour itself
 * rather than a flag a second `if` then reads: the value is compiled the same way for both, and
 * only its destination differs.
 */
export type IdDisposition = (split: PayloadSplit, value: Compiled) => void;

/** `insert` is keyed by its payload, so the `_id` it supplies is a column the new row writes. */
export const ID_AS_KEY: IdDisposition = (split, value) => {
  split.members.push({ column: ID_COLUMN, value });
};

/**
 * `update` and `replace` are keyed by what they targeted, so an `_id` states which row that is.
 *
 * Never an assignment: the write already found its rows, and a payload's `_id` narrows them to the
 * one it names rather than renaming what was found. A key naming some other row therefore matches
 * nothing and the write answers 0, which is what makes writing a document straight back — `_id`
 * and all — a no-op rather than an error.
 */
export const ID_AS_ASSERTION: IdDisposition = (split, value) => {
  split.identity = value;
};

/**
 * What the stage doing the writing does with the reserved columns.
 *
 * `_extra` is the adapter's own and is refused under every stage. `_id` and `_instance` are the
 * two a read document carries: `id` says what this stage makes of the first, and the second is
 * dropped under all of them for the reason {@link TakeReserved} gives.
 */
export interface PayloadOptions {
  id: IdDisposition;
}

const ADAPTER_OWNED =
  "is a column this adapter owns and no payload may write it";

function Refusal(name: string): Error {
  return new Error(`Payload key '${name}' ${ADAPTER_OWNED}`);
}

interface PayloadWalk {
  split: PayloadSplit;
  added: Record<string, unknown>;
  shape: TableShape;
  context: DecodingContext;
  options: PayloadOptions;
}

function Decoded(walk: PayloadWalk, value: unknown): Compiled {
  const compiled = DecodeValue(value, walk.context);
  assert(compiled, "A supplied payload value always decodes");
  return compiled;
}

/**
 * Records an undeclared key on the object the overflow document is built from.
 * Defined rather than assigned, so an own `__proto__` member is stored instead of being dropped.
 */
function Collect(walk: PayloadWalk, name: string, value: unknown): void {
  Object.defineProperty(walk.added, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Whether a payload supplied no `_id`, which `null` means exactly as `undefined` does.
 *
 * The rule has one owner because both stages have to read a key the same way: one
 * that generated a key on the way in but asserted a null on the way back would answer 0 for the
 * document it had just written.
 */
export function NoIdSupplied(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Names a key in the message {@link WrittenAs} raises for a value the column cannot hold. */
function KeySubject(name: string): string {
  return `Payload key '${name}'`;
}

/**
 * Routes the two reserved columns a payload may name, and refuses the one it may not.
 * The key is read as `TEXT` the way `get` reads it, and no value at all asserts nothing.
 *
 * `_instance` is read and dropped rather than refused, because it is a key every read document
 * carries and writing one straight back has to be the no-op the same round trip through `_id` is.
 * Dropping it is not passing over a claim the caller made: a scoped write is already pinned to one
 * instance, and a cross-instance one addresses its rows by an identity tuple that names each row's
 * instance, so no reachable write would target different rows for having honoured it. It is never
 * an assignment either — a write does not move a row between instances.
 */
function TakeReserved(walk: PayloadWalk, name: string, value: unknown): void {
  if (name === INSTANCE_COLUMN) {
    return;
  }
  if (name !== ID_COLUMN) {
    throw Refusal(name);
  }
  if (NoIdSupplied(value)) {
    return;
  }
  walk.options.id(
    walk.split,
    WrittenAs(Decoded(walk, value), TEXT, KeySubject(name)),
  );
}

/**
 * Writes one declared field into its own typed column, read as that column's type.
 * A null is SQL NULL and never a stored json null, so the read, `pluck` and `hasfields` agree.
 */
function TakeDeclared(
  walk: PayloadWalk,
  name: string,
  spec: FieldSpec,
  value: unknown,
): void {
  if (value === undefined) {
    walk.split.cleared.push(spec.column);
    return;
  }
  if (value === null && IsJsonBacked(spec.type)) {
    walk.split.members.push({
      column: spec.column,
      value: { sql: NULL_VALUE, type: spec.type },
    });
    return;
  }
  walk.split.members.push({
    column: spec.column,
    value: WrittenAs(Decoded(walk, value), spec.type, KeySubject(name)),
  });
}

function TakeUndeclared(walk: PayloadWalk, name: string, value: unknown): void {
  if (value === undefined) {
    walk.split.removed.push(name);
    return;
  }
  Collect(walk, name, value);
}

function TakeKey(walk: PayloadWalk, name: string, value: unknown): void {
  if (RESERVED_COLUMNS.includes(name)) {
    TakeReserved(walk, name, value);
    return;
  }
  if (Object.hasOwn(walk.shape.fields, name)) {
    TakeDeclared(walk, name, walk.shape.fields[name], value);
    return;
  }
  TakeUndeclared(walk, name, value);
}

/**
 * Classifies a write payload against the shape the table declares.
 *
 * A declared field is written into its own typed column, read as that column's type rather than
 * cast to it — see {@link WrittenAs}. Anything else is a member of the overflow document, and the
 * reserved columns are answered by `options`.
 *
 * `undefined` and `null` are different instructions and only one of them survives decoding: a
 * `null` is a value and is written as a json null, while `undefined` means *remove the field* and
 * is therefore read off the raw payload here, before anything is decoded — a decoded removal is
 * indistinguishable from a key that was never written. The walk reads the payload's own entries
 * rather than its defined values, since a key present with an `undefined` value is still a key the
 * caller wrote. That rule holds for every declared field and every undeclared key; `_id` is its one
 * exception and {@link TakeReserved} states why, since a null is neither a value it could store nor
 * a claim it could make.
 *
 * Nothing is decoded that the returned split does not carry: every `DecodeValue` appends to the
 * shared parameter collector, so a value compiled and then dropped binds a `$n` the statement
 * never names.
 */
export function SplitPayload(
  document: Record<string, unknown>,
  shape: TableShape,
  context: DecodingContext,
  options: PayloadOptions,
): PayloadSplit {
  const walk: PayloadWalk = {
    split: { members: [], cleared: [], removed: [] },
    added: {},
    shape,
    context,
    options,
  };
  for (const [name, value] of Object.entries(document)) {
    TakeKey(walk, name, value);
  }
  if (Object.keys(walk.added).length > 0) {
    walk.split.extra = DecodeValue(walk.added, context);
  }
  return walk.split;
}
