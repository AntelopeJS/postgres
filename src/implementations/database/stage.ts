import type { QueryStage } from "@antelopejs/interface-database/common";
import { Cast, ParsesAs } from "./coerce";
import type { DecodingContext } from "./context";
import { JsonRowSource, type RowSource } from "./row-source";
import {
  type Compiled,
  QualifiedColumn,
  QuoteIdentifier,
  QuoteLiteral,
} from "./sql";
import {
  type ArrayType,
  BOOL,
  FLOAT,
  IsJsonBacked,
  type JsonType,
  OPAQUE,
  PhysicalType,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "./types";
import { DecodeValue } from "./value";

/**
 * Accumulator threaded through the stages of one expression.
 *
 * `current` is a {@link RowSource} only while the expression is still addressing a row, which is
 * what lets `obj_index` reach a native column instead of a jsonb path. `timezone` is a pending
 * zone recorded by `date_with_timezone` and consumed by the date-part stages.
 */
export interface ExpressionState {
  current?: Compiled | RowSource;
  timezone?: string;
}

export type StageHandler = (
  state: ExpressionState,
  stage: QueryStage,
  context: DecodingContext,
) => ExpressionState;

export type StageMap = Record<string, StageHandler>;

export type ValueStage = (
  value: Compiled,
  args: readonly (Compiled | undefined)[],
  stage: QueryStage,
  context: DecodingContext,
) => Compiled;

export type RawValueStage = (
  value: Compiled,
  stage: QueryStage,
  context: DecodingContext,
) => Compiled;

export const FIRST_OPERAND = 0;
export const SECOND_OPERAND = 1;

export const FLOAT_CAST = "::double precision";

/**
 * Bounds of PostgreSQL's `integer`, which every caller-supplied subscript is clamped to.
 *
 * A jsonb subscript and an array slice bound are both `integer`, so an out-of-range one raises
 * `22003` and loses the whole statement rather than yielding NULL.
 */
export const INT4_MIN = -2147483648;
export const INT4_MAX = 2147483647;

/**
 * Clamps a caller-supplied number into the range the cast that follows can represent, truncating
 * rather than rounding.
 *
 * An out-of-range value raises `22003` and loses the whole statement rather than yielding NULL,
 * so every position and every row bound passes through here before its cast. `double precision`
 * rounds half to even on the way to an integer type, where both callers count whole units.
 *
 * `LEAST` and `GREATEST` ignore NULL, so a caller that needs an unreadable operand to stay NULL
 * has to say so around this fragment rather than inside it.
 */
export function ClampToRange(
  sql: string,
  lowest: number,
  highest: number,
): string {
  return `LEAST(GREATEST(trunc(${sql}), ${lowest}), ${highest})`;
}

const EMPTY_STATE = "Expression has no value to operate on";

function RequireCurrent(state: ExpressionState): Compiled | RowSource {
  if (!state.current) {
    throw new Error(EMPTY_STATE);
  }
  return state.current;
}

function IsCompiled(current: Compiled | RowSource): current is Compiled {
  return "sql" in current;
}

export function AsValue(state: ExpressionState): Compiled {
  const current = RequireCurrent(state);
  return IsCompiled(current) ? current : current.toJson();
}

export function AsSource(state: ExpressionState): RowSource {
  const current = RequireCurrent(state);
  return IsCompiled(current) ? new JsonRowSource(current) : current;
}

export function RequireOperand(
  value: Compiled | undefined,
  stage: QueryStage,
  index: number,
): Compiled {
  if (!value) {
    throw new Error(
      `Stage '${stage.stage}' requires an operand at position ${index}`,
    );
  }
  return value;
}

/**
 * Reads an argument that is a literal list of field *names* rather than a value.
 *
 * Decoding it instead would bind a parameter no fragment references and produce a jsonb array
 * where an identifier or a `text[]` was wanted, so every stage taking a field list — `obj_has`,
 * `pluck`, `without` — reads it through here and is written as a raw stage.
 */
export function FieldNames(
  stage: QueryStage,
  index: number = FIRST_OPERAND,
): string[] {
  const fields = stage.args[index];
  const named =
    Array.isArray(fields) && fields.every((field) => typeof field === "string");
  if (!named) {
    throw new Error(`Stage '${stage.stage}' requires a list of field names`);
  }
  return fields;
}

/** A `text[]` of literal keys, which is the operand every key-set operator takes. */
export function TextArray(names: readonly string[]): string {
  const literals = names.map(QuoteLiteral);
  return `array[${literals.join(", ")}]::${PhysicalType(TEXT)}[]`;
}

/**
 * Adapts a value-level handler into a {@link StageHandler} for a stage whose arguments are all
 * *values*: materializes the accumulator, decodes every argument through `DecodeValue` and drops
 * any pending timezone.
 *
 * A stage whose arguments are not values — `obj_has` takes a `string[]`, `arr_map` and
 * `arr_filter` take a recorded lambda — must use {@link LiftRaw} instead, or `DecodeValue` binds
 * a parameter that no fragment references and the driver rejects the statement for supplying
 * more parameters than the prepared statement takes.
 *
 * Between them the two adapters are what makes a zone recorded by `date_with_timezone` stop
 * applying for the great majority of stages. The handful written as {@link StageHandler}s
 * directly — `arg`, `constant`, `obj_index` and the date readings that consume the zone — each
 * build a fresh state and so drop it too.
 */
export function Lift(handler: ValueStage): StageHandler {
  return (state, stage, context) => {
    const value = AsValue(state);
    const args = stage.args.map((arg) => DecodeValue(arg, context));
    return { current: handler(value, args, stage, context) };
  };
}

/**
 * {@link Lift} for a stage that reads its arguments raw: same materialization and the same
 * timezone clearing, no argument decoding.
 */
export function LiftRaw(handler: RawValueStage): StageHandler {
  return (state, stage, context) => ({
    current: handler(AsValue(state), stage, context),
  });
}

/** Wraps a fragment as `double precision`, which every numeric result owes the driver. */
export function AsFloat(sql: string): Compiled {
  return { sql: `((${sql})${FLOAT_CAST})`, type: FLOAT };
}

/** Builds one handler per entry of an operator table, so a family declares only its table. */
export function BuildStages<Operator>(
  operators: Record<string, Operator>,
  build: (operator: Operator) => StageHandler,
): StageMap {
  const stages: StageMap = {};
  for (const [name, operator] of Object.entries(operators)) {
    stages[name] = build(operator);
  }
  return stages;
}

type Rendering = (sql: string) => string;

/** The zone every fragment names when the caller named none, so none reads the session's. */
export const UTC_ZONE = QuoteLiteral("UTC");

const ISO_8601_UTC = QuoteLiteral('YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

const RENDERING: Partial<Record<SqlType["kind"], Rendering>> = {
  timestamp: (sql) =>
    `(to_char(${sql} AT TIME ZONE ${UTC_ZONE}, ${ISO_8601_UTC}))`,
};

/**
 * Reads a value as text, using JavaScript's own spelling for every scalar kind.
 *
 * `<timestamptz>::text` renders under the session's `TimeZone` *and* its `DateStyle`, so the same
 * instant reaches a string operator as `2023-01-15 00:00:00+00`, `2023-01-14 19:00:00-05` or
 * `14.01.2023 19:00:00 EST` depending on server configuration — which makes `strlen()` return 22
 * or 23 and shifts `upcase()`, `concat()` and `match()` by a day. The explicit ISO 8601 rendering
 * in UTC is session-independent and is what both `Date.prototype.toISOString` and this adapter's
 * own writer produce.
 *
 * `bool` agrees with JavaScript under the plain cast, and `float` agrees over the magnitudes a
 * caller renders in practice: PostgreSQL's `float8` output reaches for exponent notation earlier
 * than `Number.prototype.toString` does — `1e+15` against `1000000000000000` — and spells the
 * exponent differently when both use it, `1e+21` against `1e21`. Rendering a number the way
 * JavaScript does would take a per-magnitude reconstruction in SQL, which is a worse trade than
 * the divergence.
 */
export function Text(value: Compiled): Compiled {
  const rendering = RENDERING[value.type.kind];
  if (!rendering) {
    return Cast(value, TEXT);
  }
  return { sql: rendering(value.sql), type: TEXT };
}

/**
 * The kinds PostgreSQL can order, each mapped to the type an ordering of it answers with.
 *
 * `min` and `max` exist for `text`, `double precision` and `timestamptz` and for nothing else — a
 * `boolean` or a jsonb operand raises `42883` and loses the whole statement — so every comparison
 * this compiler emits either reads one of these three directly or falls back to {@link Numeric}.
 * The stream aggregates and the array reducers share the table rather than each carrying one,
 * because a divergence would answer the same data differently through `min("x")` than through
 * `key("x").arr_min()` with nothing failing.
 */
export const ORDERED_KINDS: Partial<Record<SqlType["kind"], SqlType>> = {
  text: TEXT,
  float: FLOAT,
  timestamp: TIMESTAMP,
};

type Numeration = (sql: string) => string;

const MILLISECONDS_PER_SECOND = "1000";
const NUMERIC_TEXT =
  "'^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$'";

const NUMERATION: Partial<Record<SqlType["kind"], Numeration>> = {
  bool: (sql) => `((${sql})::int::double precision)`,
  timestamp: (sql) =>
    `((EXTRACT(EPOCH FROM ${sql}) * ${MILLISECONDS_PER_SECOND})::double precision)`,
  text: (sql) =>
    `(CASE WHEN ${sql} ~ ${NUMERIC_TEXT} THEN ((${sql})::double precision) END)`,
};

/**
 * Reads a value as a number, using JavaScript's `Number(x)` for every scalar kind.
 *
 * `<x>::double precision` is not an option outside `float` itself: PostgreSQL refuses the cast
 * outright for `boolean` and `timestamptz` — at *plan* time, so no row is ever read — and raises
 * `22P02` on any text that is not a number. A jsonb operand keeps the guarded projection, which
 * yields NULL for anything that is not a json number. `Number("abc")` is `NaN` in JavaScript and
 * NULL here, which is this adapter's uniform spelling for a reading that does not apply.
 */
export function Numeric(value: Compiled): Compiled {
  const numeration = NUMERATION[value.type.kind];
  if (!numeration) {
    return Cast(value, FLOAT);
  }
  return { sql: numeration(value.sql), type: FLOAT };
}

type Instant = (value: Compiled) => string;

const EARLIEST_EPOCH_MILLISECONDS = "-210866803200000";
const LATEST_EPOCH_MILLISECONDS = "8640000000000000";

const FromEpoch: Instant = (value) => {
  const millis = Numeric(value).sql;
  const bounded = `(CASE WHEN ${millis} BETWEEN ${EARLIEST_EPOCH_MILLISECONDS} AND ${LATEST_EPOCH_MILLISECONDS} THEN ${millis} END)`;
  return `(to_timestamp(${bounded} / ${MILLISECONDS_PER_SECOND}))`;
};

const FromParsedText: Instant = (value) =>
  `(CASE WHEN ${ParsesAs(value.sql, TIMESTAMP)} THEN ${Cast(value, TIMESTAMP).sql} END)`;

const INSTANT: Partial<Record<SqlType["kind"], Instant>> = {
  float: FromEpoch,
  bool: FromEpoch,
  text: FromParsedText,
};

/**
 * Reads a value as an instant, using JavaScript's `new Date(x)` for every scalar kind.
 *
 * `<x>::timestamptz` is not an option outside `timestamp` itself: PostgreSQL refuses the cast
 * outright for `double precision` and `boolean` — at *plan* time, so no row is ever read — and
 * raises `22007` on any text that is not a date. A number is therefore read as epoch
 * **milliseconds**, which is `new Date(n)`, and a boolean through the same reading `Numeric`
 * gives it. Both are bounded before `to_timestamp` sees them: `NaN`, `±Infinity` and anything
 * outside the range PostgreSQL can represent raise `22008` otherwise, and the bound is the
 * *intersection* of that range with JavaScript's own `Date` limits, so an argument JavaScript
 * calls an invalid date is NULL here rather than a timestamp it has no way to express.
 *
 * Text is parsed only where PostgreSQL's own input function accepts it — see {@link ParsesAs},
 * which needs PostgreSQL 16 and is the only construct in this module that does. That test is
 * exact in one direction, accepting every spelling a regular expression over ISO 8601 would
 * silently null, and *wider* in the other: `now`, `today`, `tomorrow`, `yesterday`, `epoch`,
 * `infinity` and `-infinity` are all valid input to `timestamptz` and all Invalid Date to
 * JavaScript, so a stored `"now"` reads as the current instant and makes the fragment
 * clock-dependent, and a stored `"infinity"` reaches `date_epoch` as `Infinity`. Narrowing that
 * would mean a regular expression, which trades a rare wrong answer for a common one.
 *
 * A jsonb operand keeps the guarded projection, which is NULL both for anything that is not a
 * json string and — since {@link Cast} applies the same input test — for a json string that is
 * not a parseable date.
 *
 * The parse itself is why `connection.ts` pins every pooled session: `timestamptz_in` resolves a
 * zone-less string under `TimeZone` and an ambiguous numeric date under `DateStyle`, and no
 * expression can branch on whether its input carries an offset.
 */
export function Moment(value: Compiled): Compiled {
  const instant = INSTANT[value.type.kind];
  if (!instant) {
    return Cast(value, TIMESTAMP);
  }
  return { sql: instant(value), type: TIMESTAMP };
}

type Truthiness = (sql: string) => string;

const TRUTHINESS: Partial<Record<SqlType["kind"], Truthiness>> = {
  bool: (sql) => sql,
  float: (sql) => `(${sql} <> 0)`,
  text: (sql) => `(${sql} <> '')`,
  timestamp: (sql) => `(${sql} IS NOT NULL)`,
};

/**
 * Reads a value as a condition, using JavaScript's truthiness for every scalar kind.
 *
 * `<x>::boolean` is not an option: PostgreSQL refuses the cast outright for `double precision`
 * and raises `22P02` on any text that is not a boolean literal, so a caller writing
 * `doc.key("age").and(…)` would lose the whole statement. A jsonb operand keeps the guarded
 * projection, which yields NULL — never an error — for anything that is not a json boolean.
 */
export function Predicate(value: Compiled): Compiled {
  const truthiness = TRUTHINESS[value.type.kind];
  if (!truthiness) {
    return Cast(value, BOOL);
  }
  return { sql: truthiness(value.sql), type: BOOL };
}

type Reading = (value: Compiled) => Compiled;

type ScalarType = Exclude<SqlType, ArrayType | JsonType>;

const STORED_READINGS: Record<ScalarType["kind"], Reading> = {
  float: Numeric,
  text: Text,
  bool: Predicate,
  timestamp: Moment,
};

/**
 * Reads a value as the type of the column it is compared against or written into.
 *
 * The readings are exactly the ones the expression compiler applies, so a value that went in
 * through here means the same thing when it comes back out through an expression; a second
 * reading table would answer the same data differently in each direction with nothing failing.
 *
 * Deliberately not {@link Cast}, which is only total from a jsonb source (invariant 13): a caller
 * writing `insert({ price: "3000" })` or `getAll(0, "isActive")` would lose the whole statement to
 * `22P02` or to a plan-time refusal rather than have one value read as best it can. The table is
 * total over the scalar kinds so a kind added later cannot fall through to the cast unnoticed;
 * the jsonb-backed kinds take {@link Cast}, where it is total because both sides are jsonb.
 */
export function StoredAs(value: Compiled, target: SqlType): Compiled {
  if (IsJsonBacked(target)) {
    return Cast(value, target);
  }
  return STORED_READINGS[target.kind](value);
}

/** jsonb's own names for the two container kinds, which every guard in the compiler reads. */
export const OBJECT_TYPEOF = "object";
export const ARRAY_TYPEOF = "array";

/** Yields NULL rather than an error when the operand is not the expected jsonb container. */
export function GuardJson(
  value: Compiled,
  expected: string,
  body: string,
): string {
  return `(CASE WHEN jsonb_typeof(${value.sql}) = '${expected}' THEN ${body} END)`;
}

type ColumnRendering = (column: string) => string;

export interface HeldValue {
  value: string;
  column: string;
  alias: string;
  select: ColumnRendering;
  guard: ColumnRendering;
}

/**
 * Guards a value the guard itself has to read, without spelling that value twice.
 *
 * {@link GuardJson} emits its operand once per branch, which is affordable for a bare column and
 * is not for a materialized document — and these constructs chain, so N of them spell 2^N copies
 * of the whole prior expression. Holding the value on a one-column derived table names it instead:
 * the select list and the guard both read the alias, and the value is emitted exactly once. A row
 * that fails the guard yields no row, which as a scalar subselect reaches the caller as NULL — the
 * same reading {@link GuardJson} gives.
 *
 * **It holds once in the *text*, not once at run time.** The planner pulls a one-row subquery up
 * and substitutes the held expression into both the output and the one-time filter, so the value is
 * evaluated twice per row either way; measured at +25 % execution against the same fragment
 * unguarded. What this buys is text that stays linear as these constructs chain, which is the whole
 * of the claim — a caller wanting the *evaluation* to happen once needs a lateral off the relation.
 */
export function HeldOnce(held: HeldValue): string {
  const relation = QuoteIdentifier(held.alias);
  const column = QualifiedColumn(held.alias, held.column);
  const source = `(SELECT ${held.value} AS ${QuoteIdentifier(held.column)})`;
  const selected = held.select(column);
  return `(SELECT ${selected} FROM ${source} AS ${relation} WHERE ${held.guard(column)})`;
}

/**
 * Resolves the field a stage names against a row source, branching on the **raw** argument.
 *
 * A literal name goes to `field`, which resolves a declared field to its own typed column and so
 * keeps `key("price")` reachable by a btree index; only a recorded expression falls through to the
 * dynamic lookup out of a materialized document. The default is a value on both branches and is
 * decoded either way, which is what keeps it a `$n` parameter rather than a literal spliced into
 * the statement.
 */
export function FieldOf(
  source: RowSource,
  stage: QueryStage,
  context: DecodingContext,
): Compiled {
  const def = DecodeValue(stage.args[SECOND_OPERAND], context);
  const name = stage.args[FIRST_OPERAND];
  if (typeof name === "string") {
    return source.field(name, def);
  }
  const key = RequireOperand(DecodeValue(name, context), stage, FIRST_OPERAND);
  return source.dynamicField(key, def);
}

/** Reads a value as jsonb, which is the operand every container stage works from. */
export function AsJson(value: Compiled): Compiled {
  return Cast(value, OPAQUE);
}

export const VALUE_COLUMN = "value";
export const ORDINAL_COLUMN = "ord";

/**
 * What an aggregation over zero rows must answer instead of NULL, spelled once.
 *
 * `jsonb_agg` yields NULL over an empty input, which would turn an empty container into a null for
 * every stage downstream — and the same is true of a nested query that read no row. Both callers
 * coalesce onto this literal, and a second spelling would be free to drift from this one with
 * nothing failing (invariant 17).
 */
export const EMPTY_ARRAY = "'[]'::jsonb";
const ORDINALITY = "WITH ORDINALITY";

export function WalkColumn(alias: string, name: string): string {
  return QualifiedColumn(alias, name);
}

/**
 * Aggregates a walked column back into a jsonb array, in the order the walk produced it.
 *
 * `jsonb_agg` preserves input order in practice but does not promise it, so the ordinality
 * column is named explicitly; and it yields NULL rather than `'[]'` over zero rows, which would
 * turn an empty container into a null for every stage downstream.
 */
export function Collected(alias: string, target: string): string {
  const order = WalkColumn(alias, ORDINAL_COLUMN);
  return `COALESCE(jsonb_agg(${target} ORDER BY ${order}), ${EMPTY_ARRAY})`;
}

export interface ElementWalk {
  func: string;
  json: string;
  alias: string;
  columns: readonly string[];
  aggregate: string;
  predicate?: string;
}

/**
 * Emits an aliased scalar subselect over a set-returning function, which is the one shape a
 * container walk can take: `jsonb_array_elements`, `jsonb_object_keys` and `jsonb_each` cannot
 * appear in an expression directly.
 *
 * Every walk takes `WITH ORDINALITY` and an alias from `context.nextAlias()`, so the natural
 * order stays addressable — see {@link Collected} — and two walks in one expression, or one
 * nested inside another, never collide.
 */
export function Walk(walk: ElementWalk): string {
  const columns = [...walk.columns, ORDINAL_COLUMN]
    .map(QuoteIdentifier)
    .join(", ");
  const relation = `${QuoteIdentifier(walk.alias)}(${columns})`;
  const source = `${walk.func}(${walk.json}) ${ORDINALITY} AS ${relation}`;
  const where = walk.predicate ? ` WHERE ${walk.predicate}` : "";
  return `(SELECT ${walk.aggregate} FROM ${source}${where})`;
}
