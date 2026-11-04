import type { TableModel } from "./fields";
import type { SqlType } from "./types";
import {
  DEFAULT_INSTANCE_ID,
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
} from "./utils";
import { IsDocument, IsNumber, IsString } from "./guards";

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
      for (const [name, keyType] of Object.entries(type.keys)) {
        if (Object.hasOwn(result, name)) {
          result[name] = ReviveValue(result[name], keyType);
        }
      }
      return result;
    }
    default:
      return value;
  }
}

export function DecodeRow(row: RowObject, table: TableModel): RowObject {
  const document: RowObject = {};
  const {
    [ID_COLUMN]: id,
    [INSTANCE_COLUMN]: instance,
    [EXTRA_COLUMN]: overflow,
  } = row;
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
  for (const [name, spec] of Object.entries(table.fields)) {
    const value = Object.hasOwn(row, spec.column)
      ? row[spec.column]
      : undefined;
    if (value === null || value === undefined) {
      continue;
    }
    document[name] = ReviveValue(value, spec.type);
  }
  // SAFETY: `_extra` is declared `jsonb NOT NULL DEFAULT '{}'` and the adapter writes it only as a jsonb object (EMPTY_EXTRA, MergeExtra), which pg parses to an object; it reads null only for a copy of a row that lacks the key (the column is NOT NULL), and undefined, which the spread drops, when the select list leaves it out.
  const extra = {
    ...(overflow as RowObject | null),
  };
  delete extra[ID_COLUMN];
  delete extra[INSTANCE_COLUMN];
  return { ...document, ...extra };
}
