import type { TableShape } from "./fields";
import type { ArrayType, JsonType, SqlShape, SqlType } from "./types";
import { EXTRA_COLUMN, ID_COLUMN } from "./utils";

type Reviver = (value: unknown, type: SqlType) => unknown;

const REVIVERS: Partial<Record<SqlType["kind"], Reviver>> = {
  timestamp: (value) =>
    value instanceof Date ? value : new Date(String(value)),
  array: (value, type) =>
    Array.isArray(value)
      ? value.map((item) => ReviveValue(item, (type as ArrayType).elem))
      : value,
  json: (value, type) => ReviveShape(value, (type as JsonType).shape),
};

export function ReviveValue(value: unknown, type: SqlType): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const reviver = REVIVERS[type.kind];
  return reviver ? reviver(value, type) : value;
}

function ReviveShape(value: unknown, shape?: SqlShape): unknown {
  if (
    !shape ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  const result: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [name, type] of Object.entries(shape)) {
    if (name in result) {
      result[name] = ReviveValue(result[name], type);
    }
  }
  return result;
}

export function DecodeRow(
  row: Record<string, unknown>,
  table: TableShape,
): Record<string, unknown> {
  const document: Record<string, unknown> = { [ID_COLUMN]: row[ID_COLUMN] };
  for (const [name, spec] of Object.entries(table.fields)) {
    const value = row[spec.column];
    if (value === null || value === undefined) {
      continue;
    }
    document[name] = ReviveValue(value, spec.type);
  }
  const extra = (row[EXTRA_COLUMN] as Record<string, unknown> | null) ?? {};
  return { ...document, ...extra };
}
