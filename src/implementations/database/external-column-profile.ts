import type {
  Categories,
  ColumnProfile,
  ColumnTrait,
  LengthStats,
  Measure,
  MonthCount,
  ValueRange,
} from "@antelopejs/interface-database-catalog";

import type { CatalogColumn } from "./external-catalog";
import {
  FirstRow,
  Mapped,
  type MeasureSession,
  ValueOf,
} from "./external-measures";
import { type Source, SOURCE_ALIAS } from "./external-sample";
import { AcceptedDeclarations } from "./external-declarations";
import { FamilyOf, type NativeFamily } from "./external-types";
import { QuoteIdentifier } from "./sql";
import type { SqlType } from "./types";

/** A column with more distinct values than this has no categories. */
const CATEGORY_LIMIT = 25;
/** A value counted fewer times than this is a record, not a category, and is never named. */
const CATEGORY_MIN_ROWS = 5;
const ENUM_LIKE_MIN_ROWS = 100;
const MONTH_LIMIT = 36;
const LABEL_DISTINCT_SHARE = 0.9;
const LABEL_MAX_LENGTH = 80;
const TIME_AXIS_FILLED_SHARE = 0.9;
const TIME_AXIS_MIN_MONTHS = 3;
const MONTHS_PER_YEAR = 12;

const TEXT_FAMILIES: readonly NativeFamily[] = ["text", "citext", "bpchar"];
const CATEGORY_FAMILIES: readonly NativeFamily[] = [
  ...TEXT_FAMILIES,
  "enum",
  "int",
  "int8",
  "bool",
];
const RANGED_KINDS: readonly SqlType["kind"][] = ["float", "timestamp"];
const DISTINCT_KINDS: readonly SqlType["kind"][] = [
  "text",
  "float",
  "bool",
  "timestamp",
];

/** A column on its way to a profile: its family, its proposed kind, and how it is read. */
export interface ProfiledColumn {
  name: string;
  family: NativeFamily;
  kind: SqlType;
  quoted: string;
}

interface BaseRow {
  nulls: number;
  min: number | string | Date | null;
  max: number | string | Date | null;
  minLength: number | null;
  avgLength: number | null;
  maxLength: number | null;
}

interface DistinctRow {
  distinct: number;
}

interface GroupRow {
  value: string | number | boolean;
  rows: number;
}

interface MonthRow {
  month: string;
  rows: number;
}

export function Profiled(column: CatalogColumn): ProfiledColumn | undefined {
  const family = FamilyOf(column);
  const [proposed] = AcceptedDeclarations(column);
  if (!family || !proposed) {
    return undefined;
  }
  return {
    name: column.name,
    family,
    kind: proposed.kind,
    quoted: `${SOURCE_ALIAS}.${QuoteIdentifier(column.name)}`,
  };
}

/** A date read as the instant registration reads it, an enum by its label, a number as one. */
function RangeExpression(column: ProfiledColumn): string | undefined {
  if (column.family === "enum") {
    return `(${column.quoted})`;
  }
  if (!RANGED_KINDS.includes(column.kind.kind)) {
    return undefined;
  }
  return column.kind.kind === "timestamp"
    ? InstantExpression(column)
    : `(${column.quoted})::float8`;
}

const INSTANTS: Partial<Record<NativeFamily, (column: string) => string>> = {
  timestamptz: (column) => column,
  timestamp: (column) => `(${column} AT TIME ZONE 'UTC')`,
  date: (column) => `((${column})::timestamp AT TIME ZONE 'UTC')`,
};

function InstantExpression(column: ProfiledColumn): string {
  return (INSTANTS[column.family] ?? ((value: string) => value))(column.quoted);
}

function BaseSql(column: ProfiledColumn, source: Source): string {
  const range = RangeExpression(column);
  const isText = TEXT_FAMILIES.includes(column.family);
  const length = `length(${column.quoted})`;
  return `SELECT (count(*) - count(${column.quoted}))::float8 AS nulls,
    ${range ? `min(${range})` : "NULL"} AS min, ${range ? `max(${range})` : "NULL"} AS max,
    ${isText ? `min(${length})` : "NULL"}::float8 AS "minLength",
    ${isText ? `avg(${length})` : "NULL"}::float8 AS "avgLength",
    ${isText ? `max(${length})` : "NULL"}::float8 AS "maxLength"
    FROM ${source.from}`;
}

function RangeValue(
  column: ProfiledColumn,
  row: BaseRow,
): ValueRange | undefined {
  if (row.min === null || row.max === null) {
    return undefined;
  }
  return { min: RangeEnd(row.min), max: RangeEnd(row.max) };
}

function RangeEnd(value: number | string | Date): number | string {
  return value instanceof Date ? value.toISOString() : value;
}

function LengthValue(row: BaseRow): LengthStats | undefined {
  if (
    row.minLength === null ||
    row.avgLength === null ||
    row.maxLength === null
  ) {
    return undefined;
  }
  return { min: row.minLength, avg: row.avgLength, max: row.maxLength };
}

interface BaseMeasures {
  nulls: Measure<number>;
  range?: Measure<ValueRange>;
  length?: Measure<LengthStats>;
}

async function MeasureBase(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
): Promise<BaseMeasures> {
  const measured = await session.measure<BaseRow>(BaseSql(column, source));
  const base: BaseMeasures = { nulls: FirstRow(measured, (row) => row.nulls) };
  const row = ValueOf(measured)?.[0];
  if (RangeExpression(column)) {
    base.range =
      measured.status === "ok"
        ? Present(row && RangeValue(column, row))
        : measured;
  }
  if (TEXT_FAMILIES.includes(column.family)) {
    base.length =
      measured.status === "ok" ? Present(row && LengthValue(row)) : measured;
  }
  return base;
}

function Present<T>(value: T | undefined): Measure<T> {
  return value === undefined
    ? { status: "error", code: "empty" }
    : { status: "ok", value };
}

async function MeasureDistinct(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
): Promise<Measure<number> | undefined> {
  if (!DISTINCT_KINDS.includes(column.kind.kind)) {
    return undefined;
  }
  const measured = await session.measure<DistinctRow>(
    `SELECT count(DISTINCT ${column.quoted})::float8 AS distinct FROM ${source.from}`,
  );
  return FirstRow(measured, (row) => row.distinct);
}

const CATEGORY_VALUES: Partial<
  Record<NativeFamily, (column: string) => string>
> = {
  int: (column) => `(${column})::float8`,
  int8: (column) => `(${column})::float8`,
  bool: (column) => column,
};

function CategoryValue(column: ProfiledColumn): string {
  return (
    CATEGORY_VALUES[column.family] ?? ((value: string) => `(${value})::text`)
  )(column.quoted);
}

/** Values counted often enough to be categories; every rarer value only adds to `other`. */
function AsCategories(rows: GroupRow[]): Categories {
  const named = rows.filter((row) => row.rows >= CATEGORY_MIN_ROWS);
  const other = rows
    .filter((row) => row.rows < CATEGORY_MIN_ROWS)
    .reduce((total, row) => total + row.rows, 0);
  return {
    values: named.map(({ value, rows: count }) => ({ value, rows: count })),
    other,
  };
}

async function MeasureCategories(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
  distinct: number | undefined,
): Promise<Measure<Categories> | undefined> {
  const isCategorical =
    column.family === "enum" || (distinct ?? Infinity) <= CATEGORY_LIMIT;
  if (!CATEGORY_FAMILIES.includes(column.family) || !isCategorical) {
    return undefined;
  }
  const measured = await session.measure<GroupRow>(
    `SELECT ${CategoryValue(column)} AS value, count(*)::float8 AS rows FROM ${source.from}
      WHERE ${column.quoted} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${CATEGORY_LIMIT + 1}`,
  );
  return Mapped(measured, AsCategories);
}

async function MeasureMonths(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
): Promise<Measure<MonthCount[]> | undefined> {
  if (column.kind.kind !== "timestamp") {
    return undefined;
  }
  const measured = await session.measure<MonthRow>(
    `SELECT to_char(date_trunc('month', ${InstantExpression(column)} AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
      count(*)::float8 AS rows FROM ${source.from}
      WHERE ${column.quoted} IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT ${MONTH_LIMIT}`,
  );
  return Mapped(measured, (rows) => rows.reverse());
}

/** Calendar months a range spans, both ends counted. */
function MonthsSpanned(range: ValueRange): number {
  const start = new Date(String(range.min));
  const end = new Date(String(range.max));
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * MONTHS_PER_YEAR +
    end.getUTCMonth() -
    start.getUTCMonth() +
    1
  );
}

/** What the relation's keys and references say about a column, for its traits. */
export interface ColumnRoles {
  keys: Set<string>;
  references: Set<string>;
}

interface TraitFacts {
  column: ProfiledColumn;
  profile: ColumnProfile;
  rows: number | undefined;
  roles: ColumnRoles;
}

type TraitRule = (facts: TraitFacts) => boolean;

function Filled(facts: TraitFacts): number | undefined {
  const nulls = ValueOf(facts.profile.nulls);
  return facts.rows === undefined || nulls === undefined
    ? undefined
    : facts.rows - nulls;
}

const TRAIT_RULES: Record<ColumnTrait, TraitRule> = {
  "enum-like": (facts) =>
    facts.column.family === "enum" ||
    (CATEGORY_FAMILIES.includes(facts.column.family) &&
      (ValueOf(facts.profile.distinct) ?? Infinity) <= CATEGORY_LIMIT &&
      (facts.rows ?? 0) >= ENUM_LIKE_MIN_ROWS),
  "identifier-like": (facts) =>
    (facts.rows ?? 0) > 0 &&
    ValueOf(facts.profile.nulls) === 0 &&
    ValueOf(facts.profile.distinct) === facts.rows,
  "label-candidate": (facts) => {
    const filled = Filled(facts) ?? 0;
    const distinct = ValueOf(facts.profile.distinct) ?? 0;
    const length = ValueOf(facts.profile.length);
    return (
      TEXT_FAMILIES.includes(facts.column.family) &&
      filled > 0 &&
      distinct >= LABEL_DISTINCT_SHARE * filled &&
      length !== undefined &&
      length.avg <= LABEL_MAX_LENGTH
    );
  },
  "time-axis": (facts) => {
    const range = ValueOf(facts.profile.range);
    return (
      facts.column.kind.kind === "timestamp" &&
      range !== undefined &&
      (Filled(facts) ?? 0) >=
        TIME_AXIS_FILLED_SHARE * (facts.rows ?? Infinity) &&
      MonthsSpanned(range) >= TIME_AXIS_MIN_MONTHS
    );
  },
  measure: (facts) =>
    facts.column.kind.kind === "float" &&
    !facts.roles.keys.has(facts.column.name) &&
    !facts.roles.references.has(facts.column.name),
};

function IsTrait(name: string): name is ColumnTrait {
  return Object.hasOwn(TRAIT_RULES, name);
}

function TraitsOf(facts: TraitFacts): ColumnTrait[] {
  return Object.keys(TRAIT_RULES)
    .filter(IsTrait)
    .filter((trait) => TRAIT_RULES[trait](facts));
}

export async function ProfileColumn(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
  rows: number | undefined,
  roles: ColumnRoles,
): Promise<ColumnProfile> {
  const base = await MeasureBase(session, column, source);
  const distinct = await MeasureDistinct(session, column, source);
  const categories = await MeasureCategories(
    session,
    column,
    source,
    ValueOf(distinct),
  );
  const months = await MeasureMonths(session, column, source);
  const profile: ColumnProfile = { name: column.name, ...base, traits: [] };
  if (distinct) {
    profile.distinct = distinct;
  }
  if (categories) {
    profile.categories = categories;
  }
  if (months) {
    profile.months = months;
  }
  profile.traits = TraitsOf({ column, profile, rows, roles });
  return profile;
}
