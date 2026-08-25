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
import { ID_COLUMN, INSTANCE_COLUMN, UNDECLARABLE_COLUMNS } from "./utils";

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
 * the field name whenever `PgIdentifier` truncated it, so a second spelling would
 * write one column and read another with nothing failing.
 */
export function DeclaredColumns(shape: TableShape): string[] {
  return Object.values(shape.fields).map((spec) => spec.column);
}

/**
 * The keys a row's document has of its own, in declaration order, which is not the column list.
 *
 * `_id` and `_instance` are prepended because neither is in `shape.fields` — the parser drops a
 * declaration of the first and refuses the second — and both are keys of the document all the
 * same. The names are logical rather than physical for the reason {@link DeclaredColumns} is the
 * opposite. The one owner of that expansion: the document a row materializes into and the keys a
 * write subtracts from an overflow document have to be the same set, or a key is both stored in
 * its column and left behind in `_extra`, where the stale copy is the one every later read
 * answers with.
 *
 * `_instance` is a key a read *answers with* and never one a write assigns: it is what tells a
 * caller reading across instances which one each row came from, and the default instance answers
 * no key at all rather than the empty string it is stored as.
 */
export function DocumentKeys(shape: TableShape): string[] {
  return [ID_COLUMN, INSTANCE_COLUMN, ...Object.keys(shape.fields)];
}

/**
 * The physical column order a row is stored in, given whatever the caller has for each part.
 *
 * The one owner of `[_id, _instance, …declared, _extra]`: the column definitions
 * the table is created with, the qualified references a row-mode select list reads back, and the
 * column list an insert names above tuples built from *different material* all have to agree on
 * both the set and the order. A second spelling is how a tuple writes each value into the column
 * beside the one it meant — same arity, no error, every row wrong — and how a fifth column added
 * to one site is dropped by the other two without a word. Generic so the same call assembles
 * names, compiled values and column plans; a fifth part is a compile error at every site.
 */
export function PhysicalOrder<T>(
  key: T,
  instance: T,
  declared: T[],
  extra: T,
): T[] {
  return [key, instance, ...declared, extra];
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

/**
 * Accepts a declared `_id`, which restates the key column rather than asking for a column.
 *
 * `_id` is reserved in the sense that the adapter owns the column, but unlike `_instance` and
 * `_extra` it is part of the document every read answers with and every write may key by. A
 * schema that declares it is stating what the adapter already stores, so it is dropped from the
 * shape and the key column continues to serve it; {@link DocumentKeys} is what puts it back.
 *
 * Only as the `text` the column is, though. A declaration of any other type is a claim the
 * adapter cannot honour — the column would still hold text — and passing it over would answer
 * every read with a value of the wrong declared type.
 */
function AssertKeyRestated(declared: FieldType, path: string): void {
  const parsed = ParseFieldType(declared, `${path}.${ID_COLUMN}`);
  if (parsed.type.kind !== TEXT.kind || parsed.codec) {
    throw new Error(
      `Field '${ID_COLUMN}' on '${path}' restates the adapter's key column and must be declared 'string'`,
    );
  }
}

export function ParseTable(table: TableDefinition, path: string): TableShape {
  const fields: Record<string, FieldSpec> = {};
  const owners = new Map<string, string>();
  for (const [name, declared] of Object.entries(table.fields ?? {})) {
    if (name === ID_COLUMN) {
      AssertKeyRestated(declared, path);
      continue;
    }
    if (UNDECLARABLE_COLUMNS.includes(name)) {
      throw new Error(
        `Field '${name}' on '${path}' uses a reserved column name (${UNDECLARABLE_COLUMNS.join(", ")})`,
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
