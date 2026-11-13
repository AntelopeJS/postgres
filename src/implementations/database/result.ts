import type { TableModel } from "./fields";
import type { SqlType } from "./types";
import {
  DEFAULT_INSTANCE_ID,
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
} from "./utils";
import { IsDocument, IsNumber, IsString } from "./guards";
import { IsPlainObject } from "./member";

/**
 * What `pg`'s default type parsers answer for one column: text, a number, a boolean, a `Date`, a
 * `Buffer`, NULL, a list of those, or an object (json, a point, an interval). A column the select
 * list did not name reads as `undefined`. A revived value is one of these too.
 */
export type RowValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | null
  | undefined
  | RowValue[]
  | RowObject;

/** A row keyed by column, a json object keyed by member, or a document keyed by field. */
export interface RowObject {
  [name: string]: RowValue;
}

/** The instant a cell spells, read from its text unless it is a number; an invalid date if it spells none. */
function InstantOf(cell: RowValue): Date {
  return IsNumber(cell) || IsString(cell)
    ? new Date(cell)
    : new Date(Number.NaN);
}

function ReviveTimestamp(value: RowValue): RowValue {
  if (value instanceof Date) {
    return value;
  }
  const date = InstantOf(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

export function ReviveValue(value: RowValue, type: SqlType): RowValue {
  if (value === null || value === undefined) {
    return value;
  }
  switch (type.kind) {
    case "timestamp":
      return ReviveTimestamp(value);
    case "array":
      return Array.isArray(value)
        ? value.map((item) => ReviveValue(item, type.elem))
        : value;
    case "json": {
      if (!type.keys || !IsDocument(value)) {
        return value;
      }
      const result = { ...value };
      for (const name of Object.keys(type.keys)) {
        if (Object.hasOwn(result, name)) {
          result[name] = ReviveValue(result[name], type.keys[name]);
        }
      }
      return result;
    }
    default:
      return value;
  }
}

/** The cell a row holds under `column` itself, never one inherited from `Object.prototype`. */
function OwnCell(row: RowObject, column: string): RowValue {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

export function DecodeRow(row: RowObject, table: TableModel): RowObject {
  const document: RowObject = {};
  const id = OwnCell(row, ID_COLUMN);
  const instance = OwnCell(row, INSTANCE_COLUMN);
  const overflow = OwnCell(row, EXTRA_COLUMN);
  if (id !== null && id !== undefined) {
    document[ID_COLUMN] = id;
  }
  if (
    instance !== null &&
    instance !== undefined &&
    instance !== DEFAULT_INSTANCE_ID
  ) {
    document[INSTANCE_COLUMN] = instance;
  }
  for (const name of Object.keys(table.fields)) {
    const spec = table.fields[name];
    const value = OwnCell(row, spec.column);
    if (value === null || value === undefined) {
      continue;
    }
    document[name] = ReviveValue(value, spec.type);
  }
  const extra = IsPlainObject(overflow) ? { ...overflow } : {};
  delete extra[ID_COLUMN];
  delete extra[INSTANCE_COLUMN];
  return { ...document, ...extra };
}
