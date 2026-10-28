import assert from "node:assert";
import { StagedObject } from "@antelopejs/interface-database/common";

import { PhysicalType, type SqlType, TEXT } from "./types";
import { DecodeValue } from "./value";
import { WrittenAs } from "./readings";
import type { DecodingContext } from "./context";
import type { Compiled } from "./sql";
import { QualifiedName } from "./identifier";
import type { ExternalRelation, TableModel } from "./fields";
import { ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import {
  type ColumnDescriptor,
  IsReadOnly,
  ReadOnlyReason,
} from "./external-types";

/** Which statement a payload is split for: the three treat keys and absences differently. */
export type ExternalWriteMode = "insert" | "update" | "replace";

/**
 * One column a write assigns, with the value read as the field's declared kind.
 *
 * `raw` is the caller's own value when it is a constant, which is what validation checks before the
 * statement runs; a value computed from the row has nothing to check ahead of time.
 */
export interface ExternalAssignment {
  field: string;
  descriptor: ColumnDescriptor;
  value: Compiled;
  raw?: unknown;
  /** A field `replace` left out of a column with a default: it is reset to that default. */
  toDefault?: boolean;
}

/**
 * A payload split for an external relation.
 *
 * `assignments` are the columns written. `asserted` names, per key column, the value the payload
 * claims for it — `_id`'s parts and key fields alike — which an insert writes and an update or a
 * replace requires the row to already have, since a write never moves a row to another key.
 */
export interface ExternalPayload {
  assignments: ExternalAssignment[];
  asserted: Map<string, AssertedKey>;
  keyFields: KeyFieldClaim[];
}

/**
 * A key column claimed through its own declared field rather than through `_id`.
 *
 * Kept apart from `_id`'s exact text because the field is read at its declared kind: a `date` over
 * a timestamp key or a `number` over a bigint beyond 2^53 is not the column's text, so it claims the
 * row a read of it answered — compared at read precision on update and replace — and is written, on
 * insert, only where `_id` does not already give the column.
 */
export interface KeyFieldClaim {
  field: string;
  descriptor: ColumnDescriptor;
  type: SqlType;
  raw: unknown;
}

/** A key field's value read as the field's declared kind, decoded where it is used. */
export function KeyFieldValue(
  claim: KeyFieldClaim,
  context: DecodingContext,
): Compiled {
  const decoded = DecodeValue(claim.raw, context) as Compiled;
  return WrittenAs(decoded, claim.type, `Field '${claim.field}'`);
}

/** A key column's claimed value, with the field that claimed it for the message a conflict raises. */
export interface AssertedKey {
  descriptor: ColumnDescriptor;
  raw: string;
  claimedBy: string;
}

/**
 * A claimed key's value, decoded where it is used: `_id` and a key field may claim the same column,
 * and a value decoded for the claim that loses would bind a parameter nothing references.
 */
export function KeyValue(
  asserted: AssertedKey,
  context: DecodingContext,
): Compiled {
  const decoded = DecodeValue(asserted.raw, context) as Compiled;
  return WrittenAs(decoded, TEXT, `Key column "${asserted.descriptor.column}"`);
}

interface ExternalWalk {
  model: TableModel;
  external: ExternalRelation;
  path: string;
  mode: ExternalWriteMode;
  context: DecodingContext;
  payload: ExternalPayload;
}

function Decoded(walk: ExternalWalk, value: unknown): Compiled {
  const decoded = DecodeValue(value, walk.context);
  if (!decoded) {
    throw new Error(`A payload value for '${walk.path}' could not be read`);
  }
  return decoded;
}

/** Whether a value is the caller's own constant, as opposed to an expression over the row. */
function IsConstant(value: unknown): boolean {
  return !(value instanceof StagedObject);
}

function Undeclared(walk: ExternalWalk, name: string): Error {
  return new Error(
    `Payload key '${name}' is not a field of '${walk.path}': ${QualifiedName(walk.external.schema, walk.external.table)} is an external relation, and only its declared fields can be written`,
  );
}

function ReadOnlyValue(
  walk: ExternalWalk,
  name: string,
  descriptor: ColumnDescriptor,
): Error {
  return new Error(
    `Field '${walk.path}.${name}' cannot be given a value: it is ${ReadOnlyReason(descriptor)}, which the database fills`,
  );
}

function KeyDisagreement(
  walk: ExternalWalk,
  column: string,
  first: string,
  second: string,
): Error {
  return new Error(
    `Payload of '${walk.path}' claims two values for key column "${column}", through '${first}' and '${second}'`,
  );
}

function MalformedId(walk: ExternalWalk, value: unknown): Error {
  return new Error(
    `Payload key '_id' of '${walk.path}' is ${JSON.stringify(value)}, which is not a key of this relation: a key of ${walk.external.key?.length ?? 0} columns is spelled as a JSON array of their texts`,
  );
}

function KeyColumn(
  walk: ExternalWalk,
  column: string,
): ColumnDescriptor | undefined {
  return walk.external.key?.find((part) => part.column === column);
}

function Claim(walk: ExternalWalk, claimed: AssertedKey): void {
  const column = claimed.descriptor.column;
  const existing = walk.payload.asserted.get(column);
  if (existing && existing.raw !== claimed.raw) {
    throw KeyDisagreement(walk, column, existing.claimedBy, claimed.claimedBy);
  }
  if (!existing) {
    walk.payload.asserted.set(column, claimed);
  }
}

/** The texts of `_id`'s parts: the value itself for a one-column key, a JSON array for a wider one. */
function IdParts(walk: ExternalWalk, value: unknown): string[] {
  const width = walk.external.key?.length ?? 0;
  if (width === 1) {
    return [KeyText(value)];
  }
  const parsed: unknown =
    typeof value === "string" ? SafeParse(value) : undefined;
  const parts = Array.isArray(parsed) ? parsed : [];
  if (
    parts.length !== width ||
    !parts.every((part): part is string => typeof part === "string")
  ) {
    throw MalformedId(walk, value);
  }
  return parts;
}

/** A key value as the text a key column is matched by: a number or a string as it is spelled. */
function KeyText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function SafeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function TakeId(walk: ExternalWalk, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  const key = walk.external.key ?? [];
  IdParts(walk, value).forEach((part, position) =>
    Claim(walk, { descriptor: key[position], raw: part, claimedBy: ID_COLUMN }),
  );
}

function TakeKeyField(
  walk: ExternalWalk,
  name: string,
  descriptor: ColumnDescriptor,
  value: unknown,
): void {
  if (value === undefined || value === null) {
    return;
  }
  walk.payload.keyFields.push({
    field: name,
    descriptor,
    type: walk.model.fields[name].type,
    raw: value,
  });
}

/**
 * Whether a key field and `_id`'s text name different keys, which only an exact reading can tell:
 * text, a number read losslessly as the same number. A lossy reading proves nothing.
 */
function Disagrees(claim: KeyFieldClaim, text: string): boolean {
  if (claim.type.kind === "text") {
    return KeyText(claim.raw) !== text;
  }
  if (claim.type.kind === "float" && !claim.descriptor.lossy) {
    return Number(text) !== claim.raw;
  }
  return false;
}

/**
 * On insert, a key field gives its column only where `_id` does not. Where both give it, they must
 * agree — checked only when the field is read as exact text, since a lossy reading of the same key
 * (a date, a bigint read as a number) is not `_id`'s spelling of it and proves nothing either way.
 */
function SettleInsertKeys(walk: ExternalWalk): void {
  walk.payload.keyFields = walk.payload.keyFields.filter((claim) => {
    const claimed = walk.payload.asserted.get(claim.descriptor.column);
    if (!claimed) {
      return true;
    }
    if (Disagrees(claim, claimed.raw)) {
      throw KeyDisagreement(
        walk,
        claim.descriptor.column,
        claimed.claimedBy,
        claim.field,
      );
    }
    return false;
  });
}

/**
 * A value for a column only the database writes. Ignored on update and replace — data-api's edit
 * writes back every field it read, these among them — and refused on insert, where nothing excuses it.
 */
function TakeReadOnly(
  walk: ExternalWalk,
  name: string,
  descriptor: ColumnDescriptor,
  value: unknown,
): void {
  if (walk.mode === "insert" && value !== undefined && value !== null) {
    throw ReadOnlyValue(walk, name, descriptor);
  }
}

function TakeField(walk: ExternalWalk, name: string, value: unknown): void {
  const spec = walk.model.fields[name];
  const descriptor = spec.native as ColumnDescriptor;
  if (KeyColumn(walk, descriptor.column)) {
    if (IsReadOnly(descriptor)) {
      TakeReadOnly(walk, name, descriptor, value);
    }
    TakeKeyField(walk, name, descriptor, value);
    return;
  }
  if (IsReadOnly(descriptor)) {
    TakeReadOnly(walk, name, descriptor, value);
    return;
  }
  if (value === undefined && walk.mode === "insert") {
    return;
  }
  const written: Compiled =
    value === undefined || value === null
      ? Absent(spec.type)
      : WrittenAs(
          Decoded(walk, value),
          spec.type,
          `Field '${walk.path}.${name}'`,
        );
  walk.payload.assignments.push({
    field: name,
    descriptor,
    value: written,
    raw:
      value !== undefined && value !== null && IsConstant(value)
        ? value
        : undefined,
  });
}

/** A NULL of the field's own type, so every expression comparing or converting it can resolve. */
function Absent(type: SqlType): Compiled {
  return { sql: `(NULL::${PhysicalType(type)})`, type };
}

function TakeKey(walk: ExternalWalk, name: string, value: unknown): void {
  if (name === ID_COLUMN) {
    TakeId(walk, value);
    return;
  }
  if (name === INSTANCE_COLUMN) {
    return;
  }
  if (!Object.hasOwn(walk.model.fields, name)) {
    throw Undeclared(walk, name);
  }
  TakeField(walk, name, value);
}

/**
 * Replace writes every writable declared field: one the payload leaves out is removed, as the
 * contract says, which in a column is NULL.
 */
function ClearSilentFields(
  walk: ExternalWalk,
  document: Record<string, unknown>,
): void {
  for (const [name, spec] of Object.entries(walk.model.fields)) {
    const descriptor = spec.native as ColumnDescriptor;
    const silent = !Object.hasOwn(document, name);
    if (
      silent &&
      !KeyColumn(walk, descriptor.column) &&
      !IsReadOnly(descriptor)
    ) {
      walk.payload.assignments.push({
        field: name,
        descriptor,
        value: Absent(spec.type),
        toDefault: descriptor.hasDefault,
      });
    }
  }
}

/**
 * Splits a document written to an external relation into the columns it assigns and the key it
 * claims, under `write-design.md` §2: declared fields only, the key never assigned outside an
 * insert, the columns only the database writes left to it.
 */
export function SplitExternalPayload(
  document: Record<string, unknown>,
  model: TableModel,
  context: DecodingContext,
  mode: ExternalWriteMode,
): ExternalPayload {
  const { external } = model;
  assert(external, "An external payload needs the relation it targets");
  const walk: ExternalWalk = {
    model,
    external,
    path: `${external.schema}.${external.table}`,
    mode,
    context,
    payload: { assignments: [], asserted: new Map(), keyFields: [] },
  };
  for (const [name, value] of Object.entries(document)) {
    TakeKey(walk, name, value);
  }
  if (mode === "insert") {
    SettleInsertKeys(walk);
  }
  if (mode === "replace") {
    ClearSilentFields(walk, document);
  }
  return walk.payload;
}
