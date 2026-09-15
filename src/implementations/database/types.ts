export interface SqlShape {
  readonly [field: string]: SqlType;
}

export interface TextType {
  readonly kind: "text";
}
export interface FloatType {
  readonly kind: "float";
}
export interface BoolType {
  readonly kind: "bool";
}
export interface TimestampType {
  readonly kind: "timestamp";
}
export interface ArrayType {
  readonly kind: "array";
  readonly elem: SqlType;
}
export interface JsonType {
  readonly kind: "json";
  readonly shape?: SqlShape;
}

export type SqlType =
  | TextType
  | FloatType
  | BoolType
  | TimestampType
  | ArrayType
  | JsonType;

export const TEXT: TextType = { kind: "text" };
export const FLOAT: FloatType = { kind: "float" };
export const BOOL: BoolType = { kind: "bool" };
export const TIMESTAMP: TimestampType = { kind: "timestamp" };
export const OPAQUE: JsonType = { kind: "json" };

const PHYSICAL_TYPES: Record<SqlType["kind"], string> = {
  text: "text",
  float: "double precision",
  bool: "boolean",
  timestamp: "timestamptz",
  array: "jsonb",
  json: "jsonb",
};

export function ArrayOf(elem: SqlType): ArrayType {
  return { kind: "array", elem };
}

/**
 * A shape that is *empty* is not a shape that is *unknown*: the first declares no members, the
 * second declares nothing about them. Only the second is {@link OPAQUE} — conflating them makes
 * `merge({})` erase what the left side declared, and a declared date then reads back as text.
 */
export function JsonOf(shape?: SqlShape): JsonType {
  if (!shape) {
    return OPAQUE;
  }
  return { kind: "json", shape };
}

export function PhysicalType(type: SqlType): string {
  return PHYSICAL_TYPES[type.kind];
}

export function IsOpaque(type: SqlType): boolean {
  return type.kind === "json" && !type.shape;
}

export function IsJsonBacked(type: SqlType): type is ArrayType | JsonType {
  return type.kind === "json" || type.kind === "array";
}

/**
 * Whether a declared type holds a *list* of values rather than one.
 *
 * The one test three stages ask: `getAll` and `lookup` both compare a scalar key
 * against a column that may hold a list, where `=` is false on every row of every dataset and `@>`
 * is the comparison a `multi` GIN index serves, and `between` refuses such a column outright. A
 * second spelling would be free to stop agreeing with the DDL that chose the index method.
 */
export function IsArray(type: SqlType): type is ArrayType {
  return type.kind === "array";
}

/** The declared members of a json type, or nothing for any type whose members are unknown. */
export function ShapeOf(type: SqlType): SqlShape | undefined {
  return type.kind === "json" ? type.shape : undefined;
}

/**
 * What concatenating two json documents leaves declared, with the right side winning a shared key.
 *
 * The one owner of that answer, for `obj_merge` and for the key a `lookup` replaces
 * — which is the same question asked of a one-member right side. Either side whose members are
 * unknown makes the whole result unknown, because `||` may then contribute a key nothing declared
 * and a shape that keeps only the left's members would claim otherwise. Only the *type* half is
 * shared: the two callers emit deliberately different SQL, guarding unconditionally in one and
 * conditionally in the other.
 */
export function MergeShapes(left: SqlType, right: SqlType): SqlType {
  const known = ShapeOf(left);
  const overriding = ShapeOf(right);
  if (!known || !overriding) {
    return OPAQUE;
  }
  return JsonOf({ ...known, ...overriding });
}
