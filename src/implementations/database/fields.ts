import type {
  FieldType,
  SchemaDefinition,
  StringFieldType,
  TableDefinition,
} from "@antelopejs/interface-database/schema";
import { PgIdentifier } from "./identifier";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  type SqlShape,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "./types";
import { ID_COLUMN, RESERVED_COLUMNS } from "./utils";

export interface IoTsCodec {
  is(value: unknown): boolean;
  encode(value: never): unknown;
  decode(value: unknown): unknown;
}

export interface ParsedField {
  type: SqlType;
  codec?: IoTsCodec;
}

export interface FieldSpec {
  column: string;
  type: SqlType;
  codec?: IoTsCodec;
}

export interface TableShape {
  fields: Record<string, FieldSpec>;
}

/**
 * The columns a table declares, in declaration order.
 *
 * The one owner of that expansion: the select list a row-mode relation reads back and the column
 * list a write names have to agree on both the set and the order, and `FieldSpec.column` is not
 * the field name whenever `PgIdentifier` truncated it (invariant 8), so a second spelling would
 * write one column and read another with nothing failing.
 */
export function DeclaredColumns(shape: TableShape): string[] {
  return Object.values(shape.fields).map((spec) => spec.column);
}

/**
 * The keys a row's document has of its own, in declaration order, which is not the column list.
 *
 * `_id` is prepended because the parser refuses it as a field and it is a document key all the
 * same (invariant 3), and the names are logical rather than physical for the reason
 * {@link DeclaredColumns} is the opposite (invariant 8). The one owner of that expansion: the
 * document a row materializes into and the keys a write subtracts from an overflow document have
 * to be the same set, or a key is both stored in its column and left behind in `_extra`, where
 * the stale copy is the one every later read answers with.
 */
export function DocumentKeys(shape: TableShape): string[] {
  return [ID_COLUMN, ...Object.keys(shape.fields)];
}

export interface SchemaShape {
  [tableId: string]: TableShape;
}

const SCALAR_TYPES: Record<string, SqlType> = {
  string: TEXT,
  number: FLOAT,
  boolean: BOOL,
  date: TIMESTAMP,
  object: OPAQUE,
  any: OPAQUE,
};

const ARRAY_SUFFIX = "[]";
const SUPPORTED_TOKENS = Object.keys(SCALAR_TYPES).join(", ");

function AsCodec(value: object): IoTsCodec | undefined {
  const candidate = value as Partial<IoTsCodec>;
  const looksLikeCodec =
    typeof candidate.encode === "function" &&
    typeof candidate.decode === "function" &&
    typeof candidate.is === "function";
  return looksLikeCodec ? (value as IoTsCodec) : undefined;
}

function UnsupportedFieldType(token: string, path: string): Error {
  return new Error(
    `Unsupported field type '${token}' for '${path}'. Supported: ${SUPPORTED_TOKENS}, optionally suffixed with [], a nested record, or an io-ts codec`,
  );
}

function ParseToken(token: string, path: string): SqlType {
  const normalized = token.trim().toLowerCase();
  if (normalized.endsWith(ARRAY_SUFFIX)) {
    return ArrayOf(ParseToken(normalized.slice(0, -ARRAY_SUFFIX.length), path));
  }
  if (!Object.hasOwn(SCALAR_TYPES, normalized)) {
    throw UnsupportedFieldType(token, path);
  }
  return SCALAR_TYPES[normalized];
}

function ParseShape(
  record: Record<string, StringFieldType>,
  path: string,
): SqlShape {
  const shape: Record<string, SqlType> = {};
  for (const [name, value] of Object.entries(record)) {
    shape[name] = ParseFieldType(value, `${path}.${name}`).type;
  }
  return shape;
}

export function ParseFieldType(field: FieldType, path: string): ParsedField {
  if (typeof field === "string") {
    return { type: ParseToken(field, path) };
  }
  if (Array.isArray(field)) {
    if (field.length !== 1) {
      throw new Error(
        `Field '${path}' must declare exactly one element type, received ${field.length}`,
      );
    }
    return { type: ArrayOf(ParseFieldType(field[0], path).type) };
  }
  if (typeof field !== "object" || field === null) {
    throw UnsupportedFieldType(String(field), path);
  }
  const codec = AsCodec(field);
  if (codec) {
    return { type: OPAQUE, codec };
  }
  return {
    type: JsonOf(ParseShape(field as Record<string, StringFieldType>, path)),
  };
}

export function ParseTable(table: TableDefinition, path: string): TableShape {
  const fields: Record<string, FieldSpec> = {};
  const owners = new Map<string, string>();
  for (const [name, declared] of Object.entries(table.fields ?? {})) {
    if (RESERVED_COLUMNS.includes(name)) {
      throw new Error(
        `Field '${name}' on '${path}' uses a reserved column name (${RESERVED_COLUMNS.join(", ")})`,
      );
    }
    const column = PgIdentifier(name);
    const owner = owners.get(column);
    if (owner !== undefined) {
      throw new Error(
        `Fields '${owner}' and '${name}' on '${path}' both map to column '${column}'; rename one`,
      );
    }
    owners.set(column, name);
    const parsed = ParseFieldType(declared, `${path}.${name}`);
    fields[name] = { column, type: parsed.type, codec: parsed.codec };
  }
  return { fields };
}

export function ParseSchema(
  schemaId: string,
  schema: SchemaDefinition,
): SchemaShape {
  const tables: SchemaShape = {};
  for (const [tableId, table] of Object.entries(schema)) {
    tables[tableId] = ParseTable(table, `${schemaId}.${tableId}`);
  }
  return tables;
}
