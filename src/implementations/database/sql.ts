import { IsJsonBacked, PhysicalType, type SqlType } from "./types";

/** Json the driver can send whole: what a jsonb parameter is serialised from. */
export type ConstantJson =
  | null
  | string
  | number
  | boolean
  | ConstantJson[]
  | { [key: string]: ConstantJson | undefined };

/** A value bound as a statement parameter: a scalar, a date, or json sent whole. */
export type ParamValue = ConstantJson | Date;

export interface Compiled {
  sql: string;
  type: SqlType;
  /** The column underneath, in its own type, where `sql` reads it converted (external relations only). */
  native?: NativeOperand;
}

/**
 * A column of a relation the adapter did not create, as a comparison can use it without converting
 * it — which is what keeps the database's own indexes serving the comparison.
 *
 * `sql` is the bare column, or a row of them for a composite key, and `order` the columns a sort
 * names one by one. `bind` converts the other operand, already read as the column's declared kind,
 * into the column's own type for `operator`, guarded so that a value the type cannot hold matches
 * nothing rather than failing the statement. `numeric` says an aggregate may read the column
 * directly, which an exact type such as `numeric` or `bigint` needs to sum without drifting.
 */
export interface NativeOperand {
  sql: string;
  order: string[];
  bind: (other: string, operator: string) => string;
  numeric: boolean;
  /** The column's type as `format_type` spells it; two operands of one type compare bare. */
  type: string;
}

/**
 * The one spelling of a json null, which is a jsonb *value* and not SQL NULL.
 *
 * Both facts that need it are downstream of that distinction — `eq(null)` has to test for it beside
 * `IS NULL`, and `COALESCE` has to be told about it — and they live in modules that cannot import
 * each other, so the literal itself lives here.
 */
export const JSON_NULL = "'null'::jsonb";

export class ParamCollector {
  private readonly values: ParamValue[] = [];

  public add(value: ParamValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  public all(): ParamValue[] {
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
  value: ParamValue,
  type: SqlType,
): Compiled {
  const encoded = IsJsonBacked(type) ? JSON.stringify(value) : value;
  return { sql: `(${params.add(encoded)}::${PhysicalType(type)})`, type };
}
