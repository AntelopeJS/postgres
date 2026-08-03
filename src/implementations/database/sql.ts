import { IsJsonBacked, PhysicalType, type SqlType } from "./types";

export interface Compiled {
  sql: string;
  type: SqlType;
}

export class ParamCollector {
  private readonly values: unknown[] = [];

  public add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  public all(): unknown[] {
    return [...this.values];
  }
}

export function QuoteIdentifier(name: string): string {
  if (name.includes("\0")) {
    throw new Error("Identifiers cannot contain NUL bytes");
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function QuoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new Error("String literals cannot contain NUL bytes");
  }
  const quoted = value.replace(/'/g, "''");
  if (!quoted.includes("\\")) {
    return `'${quoted}'`;
  }
  return `E'${quoted.replace(/\\/g, "\\\\")}'`;
}

/** References a column of an aliased relation; the single spelling every compiled fragment uses. */
export function QualifiedColumn(alias: string, column: string): string {
  return `${QuoteIdentifier(alias)}.${QuoteIdentifier(column)}`;
}

/** Reads one static key out of a jsonb expression; the single spelling both DDL and queries use. */
export function JsonKey(source: string, key: string): string {
  return `(${source} -> ${QuoteLiteral(key)})`;
}

export function Param(
  params: ParamCollector,
  value: unknown,
  type: SqlType,
): Compiled {
  const encoded = IsJsonBacked(type) ? JSON.stringify(value) : value;
  return { sql: `(${params.add(encoded)}::${PhysicalType(type)})`, type };
}
