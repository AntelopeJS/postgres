import type { CatalogColumn } from "./external-catalog";
import { type SqlType, TEXT } from "./types";
import { QuoteLiteral } from "./sql";

/**
 * The native types the adapter tells apart, each standing for the PostgreSQL types it reads alike.
 * A column whose type is in none of them is refused at registration, whatever it is declared as.
 */
type NativeFamily =
  | "text"
  | "citext"
  | "bpchar"
  | "uuid"
  | "enum"
  | "rendered"
  | "int"
  | "int8"
  | "numeric"
  | "float4"
  | "float8"
  | "bool"
  | "timestamptz"
  | "timestamp"
  | "date"
  | "jsonb"
  | "json"
  | "array";

const FAMILY_BY_TYPE: Record<string, NativeFamily> = {
  text: "text",
  varchar: "text",
  name: "text",
  citext: "citext",
  bpchar: "bpchar",
  uuid: "uuid",
  inet: "rendered",
  cidr: "rendered",
  macaddr: "rendered",
  macaddr8: "rendered",
  time: "rendered",
  timetz: "rendered",
  int2: "int",
  int4: "int",
  int8: "int8",
  numeric: "numeric",
  float4: "float4",
  float8: "float8",
  bool: "bool",
  timestamptz: "timestamptz",
  timestamp: "timestamp",
  date: "date",
  jsonb: "jsonb",
  json: "json",
};

const ENUM_TYPTYPE = "e";
const ARRAY_CATEGORY = "A";

type ValueExpression = (column: string) => string;

/** How a column of one family is read as one declared kind, and what that reading loses. */
interface Reading {
  value: ValueExpression;
  lossy?: string;
}

const Bare: ValueExpression = (column) => column;

const AsText: ValueExpression = (column) => `(${column})::text`;

const AsFloat: ValueExpression = (column) => `(${column})::double precision`;

const AsJsonb: ValueExpression = (column) => `(${column})::jsonb`;

const AsJsonArray: ValueExpression = (column) => `to_jsonb(${column})`;

const NaiveAsUtc: ValueExpression = (column) =>
  `(${column} AT TIME ZONE 'UTC')`;

const DateAsUtc: ValueExpression = (column) =>
  `((${column})::timestamp AT TIME ZONE 'UTC')`;

const MICROSECONDS = "microseconds are truncated to milliseconds";

const TEXT_READINGS: Partial<Record<NativeFamily, Reading>> = {
  text: { value: Bare },
  citext: { value: Bare },
  bpchar: { value: AsText },
  uuid: { value: AsText },
  enum: { value: AsText },
  rendered: { value: AsText },
  int: { value: AsText },
  int8: { value: AsText },
  numeric: { value: AsText },
};

const FLOAT_READINGS: Partial<Record<NativeFamily, Reading>> = {
  int: { value: AsFloat },
  int8: {
    value: AsFloat,
    lossy:
      "a bigint beyond 2^53 loses precision as a number; declare it string to read it exactly",
  },
  numeric: {
    value: AsFloat,
    lossy:
      "a numeric loses precision as a number; declare it string to read it exactly",
  },
  float4: {
    value: AsFloat,
    lossy: "a real widened to a number is not the decimal it was written as",
  },
  float8: { value: Bare },
};

const TIMESTAMP_READINGS: Partial<Record<NativeFamily, Reading>> = {
  timestamptz: { value: Bare, lossy: MICROSECONDS },
  timestamp: {
    value: NaiveAsUtc,
    lossy: `a timestamp without time zone is read as UTC; ${MICROSECONDS}`,
  },
  date: { value: DateAsUtc },
};

const JSON_READINGS: Partial<Record<NativeFamily, Reading>> = {
  jsonb: { value: Bare },
  json: {
    value: AsJsonb,
    lossy:
      "json is read as jsonb: duplicate keys, key order and whitespace are not kept",
  },
};

/**
 * Every pairing of a declared kind with a native family that registration accepts.
 *
 * The one owner of the type policy: a pairing absent here is refused, a pairing with a `lossy`
 * reason is accepted with that reason as its warning, and the value expression is how every read
 * of the column sees it. Arrays are read element-wise through {@link ARRAY_ELEMENTS} instead.
 */
const READINGS: Record<
  SqlType["kind"],
  Partial<Record<NativeFamily, Reading>>
> = {
  text: TEXT_READINGS,
  float: FLOAT_READINGS,
  bool: { bool: { value: Bare } },
  timestamp: TIMESTAMP_READINGS,
  json: JSON_READINGS,
  array: {},
};

/**
 * The element families an array of each kind is read from, through `to_jsonb`, which spells each
 * element as the json value of its type. A timestamp element is absent: `to_jsonb` renders it under
 * the session zone without an offset, which no element-wise reading can repair.
 */
const ARRAY_ELEMENTS: Partial<
  Record<SqlType["kind"], Partial<Record<NativeFamily, Reading>>>
> = {
  text: {
    text: { value: Bare },
    citext: { value: Bare },
    uuid: { value: Bare },
    enum: { value: Bare },
  },
  float: {
    int: { value: Bare },
    float8: { value: Bare },
    int8: { value: Bare, lossy: FLOAT_READINGS.int8?.lossy },
    numeric: { value: Bare, lossy: FLOAT_READINGS.numeric?.lossy },
    float4: { value: Bare, lossy: FLOAT_READINGS.float4?.lossy },
  },
  bool: { bool: { value: Bare } },
  json: { jsonb: { value: Bare } },
};

const DECLARED_NAMES: Record<SqlType["kind"], string> = {
  text: "string",
  float: "number",
  bool: "boolean",
  timestamp: "date",
  json: "object",
  array: "an array",
};

/**
 * One declared field over the column it reads, with everything every later stage needs: how to
 * read the column as the declared kind, and the flags a write will need. Built once at
 * registration, from the catalog.
 */
export interface ColumnDescriptor {
  field: string;
  column: string;
  kind: SqlType;
  family: NativeFamily;
  native: string;
  castType: string;
  value: ValueExpression;
  lossy?: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  identity: string;
}

/** The family a type belongs to, with enums and arrays recognised by kind rather than by name. */
function FamilyOf(column: CatalogColumn): NativeFamily | undefined {
  if (column.typtype === ENUM_TYPTYPE) {
    return "enum";
  }
  if (column.category === ARRAY_CATEGORY) {
    return "array";
  }
  return FAMILY_BY_TYPE[column.typname];
}

function ElementFamily(column: CatalogColumn): NativeFamily | undefined {
  if (!column.element) {
    return undefined;
  }
  return FAMILY_BY_TYPE[column.element];
}

function ArrayReading(
  kind: SqlType,
  column: CatalogColumn,
): Reading | undefined {
  if (kind.kind !== "array") {
    return undefined;
  }
  const element = ElementFamily(column);
  const readings = ARRAY_ELEMENTS[kind.elem.kind];
  const reading = element ? readings?.[element] : undefined;
  return reading ? { value: AsJsonArray, lossy: reading.lossy } : undefined;
}

function ReadingOf(
  kind: SqlType,
  family: NativeFamily | undefined,
  column: CatalogColumn,
): Reading | undefined {
  if (family === "array") {
    return ArrayReading(kind, column);
  }
  return family ? READINGS[kind.kind][family] : undefined;
}

/** The declared kinds a family can be read as, for the message that refuses one it cannot. */
function AcceptedNames(family: NativeFamily | undefined): string {
  const kinds = Object.entries(READINGS)
    .filter(
      ([, readings]) => family !== undefined && readings[family] !== undefined,
    )
    .map(([kind]) => DECLARED_NAMES[kind as SqlType["kind"]]);
  return kinds.length > 0
    ? `declare it as ${kinds.join(" or ")}`
    : "no field type reads it";
}

function Refusal(path: string, kind: SqlType, column: CatalogColumn): Error {
  const family = FamilyOf(column);
  return new Error(
    `Field '${path}' is declared ${DECLARED_NAMES[kind.kind]}, but column "${column.name}" is ${column.native}: ${AcceptedNames(family)}`,
  );
}

/**
 * Describes a declared field over the catalog column it reads, or refuses a pairing §2's matrix
 * does not accept, naming the field, the column, its type and the declarations that would read it.
 */
export function Describe(
  field: string,
  kind: SqlType,
  column: CatalogColumn,
  path: string,
): ColumnDescriptor {
  const family = FamilyOf(column);
  const reading = ReadingOf(kind, family, column);
  if (!reading || !family) {
    throw Refusal(path, kind, column);
  }
  return {
    field,
    column: column.name,
    kind,
    family,
    native: column.native,
    castType: column.castType,
    value: reading.value,
    lossy: reading.lossy,
    notNull: column.notNull,
    hasDefault: column.hasDefault,
    generated: column.generated,
    identity: column.identity,
  };
}

/**
 * The families a key column may have, each read as the text `_id` is built from. A date or an
 * instant renders as ISO text under the session `DateStyle` and `TimeZone` every pooled connection
 * pins, so its `_id` is stable; a float or a json column is no identity and is not offered.
 */
const KEY_READINGS: Partial<Record<NativeFamily, Reading>> = {
  ...TEXT_READINGS,
  date: { value: AsText },
  timestamptz: { value: AsText },
  timestamp: { value: AsText },
  bool: { value: AsText },
};

/** A key column read as text for `_id`, or nothing when its type cannot serve as an identity. */
export function DescribeKey(
  column: CatalogColumn,
): ColumnDescriptor | undefined {
  const family = FamilyOf(column);
  const reading = family ? KEY_READINGS[family] : undefined;
  if (!reading || !family) {
    return undefined;
  }
  return {
    field: column.name,
    column: column.name,
    kind: TEXT,
    family,
    native: column.native,
    castType: column.castType,
    value: reading.value,
    notNull: column.notNull,
    hasDefault: column.hasDefault,
    generated: column.generated,
    identity: column.identity,
  };
}

/** Converts the other operand of a comparison, read as the declared kind, to the column's type. */
export type Conversion = (other: string, operator: string) => string;

const Unconverted: Conversion = (other) => other;

/**
 * A text value read as `type` where it is valid input for it, and NULL where it is not, so an
 * invalid uuid or an unknown enum label matches nothing instead of failing the statement.
 *
 * **The cast sits outside the `CASE`.** Under a custom plan the bound value is a constant, and the
 * planner folds an immutable cast inside a `THEN` arm before the condition is ever evaluated, so
 * `CASE WHEN pg_input_is_valid(x, T) THEN x::T END` still raises on that value. Casting the
 * `CASE`'s text result leaves no constant cast to fold (`experiments/09b`, `09c`).
 */
function Guarded(other: string, type: string): string {
  return `((CASE WHEN pg_input_is_valid(${other}, ${QuoteLiteral(type)}) THEN ${other} END)::${type})`;
}

/**
 * The rounding that keeps an integer comparison against a fractional number exact: `n > 5.5` is
 * `n > 5`, `n >= 5.5` is `n >= 6`. Equality takes no rounding — it matches only a whole number.
 */
const INTEGER_ROUNDING: Record<string, string> = {
  ">": "floor",
  "<=": "floor",
  ">=": "ceil",
  "<": "ceil",
};

/** Inside the bigint range with room to spare, since a `double precision` bound cannot name its edge. */
const INTEGER_BOUND = "9.2e18";

function Clamped(sql: string): string {
  return `(LEAST(GREATEST(${sql}, -${INTEGER_BOUND}), ${INTEGER_BOUND}))::bigint`;
}

/**
 * A number compared with an integer column, as the `bigint` every integer type has a cross-type
 * operator with, so the column's index serves it. An ordering rounds toward the operator, and
 * equality keeps only a whole number in range; either way the cast cannot raise.
 */
const IntegerConversion: Conversion = (other, operator) => {
  const rounding = INTEGER_ROUNDING[operator];
  if (rounding) {
    return `(${Clamped(`${rounding}(${other})`)})`;
  }
  return `(CASE WHEN ${other} = trunc(${other}) AND abs(${other}) <= ${INTEGER_BOUND} THEN (${other})::bigint END)`;
};

function Cast(type: string): Conversion {
  return (other) => `(${other})::${type}`;
}

function GuardedAs(type: string): Conversion {
  return (other) => Guarded(other, type);
}

const AtUtc: Conversion = (other) => `(${other} AT TIME ZONE 'UTC')`;

/** `real` equality: the number as the `real` the column stores, since 0.1::real is not 0.1. */
const RealConversion: Conversion = (other, operator) =>
  operator === "=" ? `(${other})::real` : other;

type ConversionOf = (castType: string) => Conversion;

/**
 * How the other operand reaches each family's own type, per declared kind. A family absent here
 * compares by value expression instead: correct, without the column's index — `json` has no
 * equality at all, and an array is compared as the jsonb it is read as.
 */
const CONVERSIONS: Partial<
  Record<SqlType["kind"], Partial<Record<NativeFamily, ConversionOf>>>
> = {
  text: {
    text: () => Unconverted,
    citext: () => Cast("citext"),
    bpchar: () => Cast("bpchar"),
    uuid: GuardedAs,
    enum: GuardedAs,
    rendered: GuardedAs,
    int: GuardedAs,
    int8: GuardedAs,
    numeric: GuardedAs,
    date: GuardedAs,
    timestamptz: GuardedAs,
    timestamp: GuardedAs,
    bool: GuardedAs,
  },
  float: {
    float8: () => Unconverted,
    float4: () => RealConversion,
    int: () => IntegerConversion,
    int8: () => IntegerConversion,
    numeric: () => Cast("numeric"),
  },
  bool: { bool: () => Unconverted },
  timestamp: {
    timestamptz: () => Unconverted,
    timestamp: () => AtUtc,
    date: () => AtUtc,
  },
};

/**
 * The families an aggregate reads directly: exact types, whose own `sum` is exact. `real` is left
 * out — PostgreSQL adds a `real` column in single precision — and so is `double precision`, whose
 * value expression is the column already.
 */
const NUMERIC_FAMILIES: readonly NativeFamily[] = ["int", "int8", "numeric"];

/** How a comparison converts the other operand for this column, or nothing to compare by value. */
export function ConversionFor(
  descriptor: ColumnDescriptor,
): Conversion | undefined {
  return CONVERSIONS[descriptor.kind.kind]?.[descriptor.family]?.(
    descriptor.castType,
  );
}

/** Whether an aggregate may read this column directly: a number read from an exact numeric type. */
export function IsNumeric(descriptor: ColumnDescriptor): boolean {
  return (
    descriptor.kind.kind === "float" &&
    NUMERIC_FAMILIES.includes(descriptor.family)
  );
}
