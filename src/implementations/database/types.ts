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

export function JsonOf(shape?: SqlShape): JsonType {
  if (!shape || Object.keys(shape).length === 0) {
    return OPAQUE;
  }
  return { kind: "json", shape };
}

export function PhysicalType(type: SqlType): string {
  return PHYSICAL_TYPES[type.kind];
}

export function IsOpaque(type: SqlType): boolean {
  if (type.kind !== "json") {
    return false;
  }
  return !type.shape || Object.keys(type.shape).length === 0;
}

export function IsJsonBacked(type: SqlType): type is ArrayType | JsonType {
  return type.kind === "json" || type.kind === "array";
}

/** The declared members of a json type, or nothing for any type whose members are unknown. */
export function ShapeOf(type: SqlType): SqlShape | undefined {
  return type.kind === "json" ? type.shape : undefined;
}
