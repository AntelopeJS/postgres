import type { TableModel } from "./fields";
import type { KeyTypes, SqlType } from "./types";
import {
  DEFAULT_INSTANCE_ID,
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
} from "./utils";

function ReviveTimestamp(value: unknown): unknown {
  if (value instanceof Date) {
    return value;
  }
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? value : date;
}

export function ReviveValue(value: unknown, type: SqlType): unknown {
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
    case "json":
      return ReviveKeyTypes(value, type.keys);
    default:
      return value;
  }
}

function ReviveKeyTypes(value: unknown, keyTypes?: KeyTypes): unknown {
  if (
    !keyTypes ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  const result: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [name, type] of Object.entries(keyTypes)) {
    if (Object.hasOwn(result, name)) {
      result[name] = ReviveValue(result[name], type);
    }
  }
  return result;
}

export function DecodeRow(
  row: Record<string, unknown>,
  table: TableModel,
): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  const id = row[ID_COLUMN];
  if (id !== null && id !== undefined) {
    document[ID_COLUMN] = id;
  }
  const instance = row[INSTANCE_COLUMN];
  if (
    instance !== null &&
    instance !== undefined &&
    instance !== DEFAULT_INSTANCE_ID
  ) {
    document[INSTANCE_COLUMN] = instance;
  }
  for (const [name, spec] of Object.entries(table.fields)) {
    const value = row[spec.column];
    if (value === null || value === undefined) {
      continue;
    }
    document[name] = ReviveValue(value, spec.type);
  }
  const extra = {
    ...(row[EXTRA_COLUMN] as Record<string, unknown> | null),
  };
  delete extra[ID_COLUMN];
  delete extra[INSTANCE_COLUMN];
  return { ...document, ...extra };
}
