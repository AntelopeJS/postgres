import { Query, ValueProxy } from "@antelopejs/interface-database";
import { StagedObject } from "@antelopejs/interface-database/common";

import { IsBoolean, IsDocument, IsNumber, IsObject, IsString } from "./guards";
import type { ConstantJson } from "./sql";

/**
 * A non-array object read as a document: its own members, classified when they are asked for.
 *
 * Each call reads the object again, as `Object.entries` and a property read do, so a getter runs
 * exactly when the walk that asked for it runs.
 */
export interface DocumentView {
  entries(): [string, Member][];
  /** The member at an own key, or `undefined` for a key the object does not own. */
  own(name: string): Member | undefined;
  ownNames(): string[];
}

/** What every member answers, whichever kind it is. */
interface MemberFacts {
  /** What `typeof` answers for the value, which is the only thing a refusal says about it. */
  typeName: string;
  /** The value as `JSON.stringify` spells it, for a message or a key's text. */
  json(): string;
  /** The value as `String` spells it, which is what a timestamp cell that is no number is read from. */
  text(): string;
  /** The value read as a document, for a non-array object. */
  document: DocumentView | undefined;
}

interface Scalar<Kind extends string, Value> extends MemberFacts {
  kind: Kind;
  value: Value;
}

interface Staged<Kind extends string> extends Scalar<Kind, StagedObject> {
  identity: object;
}

/** A list, whose items are classified when they are asked for, so a cyclic list costs nothing. */
export interface ListMember extends MemberFacts {
  kind: "list";
  identity: object;
  items(): Member[];
  /** The list itself when every item is json the driver can send whole. */
  constant(): ConstantJson[] | undefined;
}

/** An object literal, as opposed to an instance of something. */
interface RecordMember extends MemberFacts {
  kind: "record";
  identity: object;
  document: DocumentView;
}

/** A value no walk reads: a `bigint`, a `symbol`, a function or an instance such as a `Buffer`. */
interface OpaqueMember extends MemberFacts {
  kind: "opaque";
}

interface Marker<Kind extends string> extends MemberFacts {
  kind: Kind;
}

/**
 * One value out of a caller's document or a stage's arguments, parsed once into what it is.
 *
 * The walkers branch on `kind` and read only what that kind carries. `opaque` carries nothing but
 * the facts, so a walk that ignores it (a read-only column) leaves it alone and one that decodes it
 * refuses it, as the caller's value was before it was parsed.
 */
export type Member =
  | Marker<"absent">
  | Marker<"null">
  | Scalar<"text", string>
  | Scalar<"number", number>
  | Scalar<"boolean", boolean>
  | Scalar<"date", Date>
  | Staged<"proxy">
  | Staged<"query">
  | Staged<"staged">
  | ListMember
  | RecordMember
  | OpaqueMember;

/**
 * Whether a value is an object literal rather than an instance of something.
 *
 * The distinction is what tells a document apart from a `ValueProxy`, which is an object too.
 */
export function IsPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return IsObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Whether a value is json the driver can send whole, rather than an expression to compile.
 *
 * A `ValueProxy` or a `Query` reads the row and has to be emitted as SQL; a `Date` is deliberately
 * excluded because `to_jsonb(timestamptz)` and `JSON.stringify` do not spell the same instant.
 */
function IsConstantJson(value: unknown): value is ConstantJson {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(IsConstantJson);
  }
  if (IsPlainObject(value)) {
    return Object.values(value).every(
      (item) => item === undefined || IsConstantJson(item),
    );
  }
  return IsString(value) || IsNumber(value) || IsBoolean(value);
}

function IsBigInt(value: unknown): value is bigint {
  return typeof value === "bigint";
}

function IsSymbol(value: unknown): value is symbol {
  return typeof value === "symbol";
}

function IsUndefined(value: unknown): value is undefined {
  return typeof value === "undefined";
}

function IsNullOrObject(value: unknown): value is object | null {
  return value === null || IsObject(value);
}

/** What `typeof` answers, spelled from the guards; a value none of them takes is a function. */
const TYPE_NAMES = [
  [IsString, "string"],
  [IsNumber, "number"],
  [IsBoolean, "boolean"],
  [IsUndefined, "undefined"],
  [IsBigInt, "bigint"],
  [IsSymbol, "symbol"],
  [IsNullOrObject, "object"],
] as const;

/**
 * Parses one caller value into the kind every walker branches on. Total: every value has a kind.
 *
 * It looks at the value and goes no deeper, so a cyclic document in a column the walk ignores is
 * never walked. The order is the order the kinds were always told apart in, which is what makes a
 * `ValueProxy` a proxy before it is an object.
 */
export function ClassifyMember(value: unknown): Member {
  const document: DocumentView | undefined = IsDocument(value)
    ? {
        entries: () =>
          Object.entries(value).map(([name, item]) => [
            name,
            ClassifyMember(item),
          ]),
        own: (name) =>
          Object.hasOwn(value, name) ? ClassifyMember(value[name]) : undefined,
        ownNames: () => Object.getOwnPropertyNames(value),
      }
    : undefined;
  const facts: MemberFacts = {
    typeName: TYPE_NAMES.find(([test]) => test(value))?.[1] ?? "function",
    json: () => JSON.stringify(value),
    text: () => String(value),
    document,
  };
  if (value === undefined) {
    return { ...facts, kind: "absent" };
  }
  if (value === null) {
    return { ...facts, kind: "null" };
  }
  if (value instanceof ValueProxy) {
    return { ...facts, kind: "proxy", value, identity: value };
  }
  if (value instanceof Query) {
    return { ...facts, kind: "query", value, identity: value };
  }
  if (value instanceof StagedObject) {
    return { ...facts, kind: "staged", value, identity: value };
  }
  if (value instanceof Date) {
    return { ...facts, kind: "date", value };
  }
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    return {
      ...facts,
      kind: "list",
      identity: list,
      items: () => list.map((item) => ClassifyMember(item)),
      constant: () => (list.every(IsConstantJson) ? list : undefined),
    };
  }
  if (IsPlainObject(value) && document) {
    return { ...facts, kind: "record", identity: value, document };
  }
  if (IsString(value)) {
    return { ...facts, kind: "text", value };
  }
  if (IsNumber(value)) {
    return { ...facts, kind: "number", value };
  }
  if (IsBoolean(value)) {
    return { ...facts, kind: "boolean", value };
  }
  return { ...facts, kind: "opaque" };
}
