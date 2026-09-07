import { type Compiled, QuoteLiteral } from "./sql";
import { Cast, ParsesAs, WithDefault } from "./coerce";
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

/** Wraps a fragment as `double precision`, which every numeric result owes the driver. */
export function AsFloat(sql: string): Compiled {
  return { sql: `((${sql})${FLOAT_CAST})`, type: FLOAT };
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
 * Reads a value as a number, following JavaScript's `Number(x)` where the two systems agree.
 *
 * `<x>::double precision` is not an option outside `float` itself: PostgreSQL refuses the cast
 * outright for `boolean` and `timestamptz` — at *plan* time, so no row is ever read — and raises
 * `22P02` on any text that is not a number. A jsonb operand keeps the guarded projection, which
 * yields NULL for anything that is not a json number. `Number("abc")` is `NaN` in JavaScript and
 * NULL here, which is this adapter's uniform spelling for a reading that does not apply.
 *
 * **The text reading is narrower than `Number` and deliberately so**, which is why this does not
 * claim to be it: the pattern admits a decimal literal with an optional sign, exponent and
 * surrounding space, and nothing else. So `""` is NULL where `Number("")` is `0`, `"0x10"` is NULL
 * where JavaScript reads 16, and `"Infinity"` is NULL where JavaScript and `float8` both read an
 * infinity. The first two are inputs `float8` itself refuses, and the third is a value nothing
 * downstream can carry — json cannot spell it and {@link ClampToRange} exists because the integer
 * casts raise on it. A wider pattern would trade a NULL for a value the caller did not store.
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

/**
 * The whole of JavaScript's falsy table over a jsonb value; `NaN` and `undefined` have no spelling.
 * Everything not listed is true, including `[]`, `{}` and the string `"false"`.
 */
const FALSY_JSON = ["null", "false", "0", '""'];

const FALSEHOOD = `array[${FALSY_JSON.map(QuoteLiteral).join(", ")}]::${PhysicalType(OPAQUE)}[]`;

const JsonTruthiness: Truthiness = (sql) => `(${sql} <> ALL (${FALSEHOOD}))`;

const TRUTHINESS: Record<SqlType["kind"], Truthiness> = {
  bool: (sql) => sql,
  float: (sql) => `(${sql} <> 0)`,
  text: (sql) => `(${sql} <> '')`,
  timestamp: (sql) => `(${sql} IS NOT NULL)`,
  json: JsonTruthiness,
  array: JsonTruthiness,
};

/**
 * Reads a value as a condition, using JavaScript's truthiness for every kind.
 *
 * `<x>::boolean` is not an option: PostgreSQL refuses the cast outright for `double precision`
 * and raises `22P02` on any text that is not a boolean literal, so a caller writing
 * `doc.key("age").and(…)` would lose the whole statement.
 *
 * The table is total rather than falling through to {@link Cast} for a jsonb operand, and the
 * totality is the point. That projection is NULL for everything that is not a json boolean, so a
 * stored `["a"]`, `{"k":1}` or `7` was null in both directions — dropped from `filter(k)` and from
 * `filter(k.not())` alike, since `not` spells `IS NOT TRUE` and asserts a null operand *into* the
 * result. A silent omission on one side is a wrong answer on the other, and only a reading that
 * answers for every jsonb value fixes both.
 *
 * SQL NULL stays NULL, which is what the four scalar readings do and what makes the three-valued
 * logic agree with JavaScript: an absent key is dropped from `filter(k)` and `filter(k.and(x))`,
 * kept by `filter(k.not())` and `filter(k.or(true))`, exactly as `undefined` is.
 *
 * Spelled as one operator over a constant array rather than a `jsonb_typeof` dispatch: a `CASE`
 * is one opaque expression no index can serve, and it would have to spell the
 * operand twice where this spells it once.
 */
export function Predicate(value: Compiled): Compiled {
  return { sql: TRUTHINESS[value.type.kind](value.sql), type: BOOL };
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
 * Reads a value as the type of the column it is compared against.
 *
 * Over a scalar key the readings are exactly the ones the expression compiler applies, so a key that
 * addressed a row on the way in addresses it on the way back; a second reading table would answer
 * the same data differently in each direction with nothing failing. The write path
 * goes through {@link WrittenAs}, which is this table with one entry narrowed and states why there.
 *
 * Deliberately not {@link Cast}, which is only total from a jsonb source: a caller
 * writing `insert({ price: "3000" })` or `getAll(0, "isActive")` would lose the whole statement to
 * `22P02` or to a plan-time refusal rather than have one value read as best it can. The table is
 * total over the scalar kinds so a kind added later cannot fall through to the cast unnoticed.
 *
 * Either side being jsonb takes {@link Cast} instead, where it is total: a jsonb *target* because
 * both sides are then jsonb, and a jsonb *source* because the projection out of jsonb is guarded.
 * The source half is what the four readings each did on their own before {@link Predicate} became
 * total over jsonb, and it is stated here because only one of them would have stopped. Truthiness
 * is the reading a *condition* wants and not the reading a *key* wants: `getAll(null, "isActive")`
 * addresses no row under the projection, which is the honest answer to a key that cannot be
 * matched, where truthiness would hand back every row holding `false`.
 */
export function StoredAs(value: Compiled, target: SqlType): Compiled {
  if (IsJsonBacked(target) || IsJsonBacked(value.type)) {
    return Cast(value, target);
  }
  return STORED_READINGS[target.kind](value);
}

type Written = (value: Compiled, subject: string) => Compiled;

/**
 * Reads a caller-supplied value against a `boolean` column, which only a boolean is.
 * The one reading narrower than {@link StoredAs}'s, since {@link Predicate} is total and so silent.
 */
const BOOLEAN_ONLY =
  `takes a ${PhysicalType(BOOL)} or a json ${PhysicalType(BOOL)}` +
  ` for a ${PhysicalType(BOOL)} column`;

const StoredBoolean: Written = (value, subject) => {
  if (value.type.kind === "bool") {
    return value;
  }
  if (IsJsonBacked(value.type)) {
    return Cast(value, BOOL);
  }
  throw new Error(
    `${subject} ${BOOLEAN_ONLY}, received ${PhysicalType(value.type)}`,
  );
};

const WRITTEN_READINGS: Partial<Record<SqlType["kind"], Written>> = {
  bool: StoredBoolean,
};

/**
 * Reads a value being written into a column as that column's type.
 *
 * {@link StoredAs} with one narrower entry rather than a table of its own: the readings a typed
 * column forces on the way in are genuinely useful — `Numeric("3000")` is `3000` and
 * `Moment("2023-01-15")` is a timestamp — and a second table would be free to answer the same data
 * differently in each direction with nothing failing. Only `bool` differs, and
 * {@link StoredBoolean} says why.
 *
 * **Both callers hand this a value the caller supplied against a declared column**, which is what
 * makes one reading right for both: a payload member and a `key(name, def)` default are the same
 * question — read this as the column's type — and the same failure if truthiness answers it, since
 * `key("isElectric", "false")` would default to `true` as surely as `insert` would store it.
 */
export function WrittenAs(
  value: Compiled,
  target: SqlType,
  subject: string,
): Compiled {
  const narrowed = WRITTEN_READINGS[target.kind];
  if (!narrowed) {
    return StoredAs(value, target);
  }
  return narrowed(value, subject);
}

/**
 * A **field's** default, read as the type of the column it stands in for.
 *
 * {@link WithDefault} on its own *unifies* the two, and two different concrete kinds meet at the
 * bottom type: `key("price", "0")` cast the **column** to jsonb, so a comparison over it stopped
 * reaching the btree index and a `timestamp` column stopped being revived as a `Date`. A default
 * nothing ever returned still changed how every row was read. Reading the default *into* the
 * column's type instead leaves that type — and everything downstream of it — untouched, and where
 * the two already agree {@link Cast} is the identity, so nothing that worked emits a byte
 * differently.
 *
 * **The `default` *stage* deliberately does not come through here, and the two are not the same
 * promise.** `key(name, def)` names a declared column, which has an index and a revival to lose;
 * `.default(def)` composes over any expression, and the contract's own conformance suite writes
 * `row.key("status").eq("completed").default("pending")` — a *string* standing in for a boolean.
 * There the default is an alternative value rather than a value of the column's type, and unifying
 * to the bottom type is what makes it work. Extending this reading to that stage compiles, passes
 * every unit spec, and fails `Merge with Conditional Logic`.
 *
 * A column already at the bottom type keeps the unification, since that is where both sides are.
 */
export function Defaulted(
  value: Compiled,
  def: Compiled | undefined,
  subject: string,
): Compiled {
  if (!def) {
    return value;
  }
  return WithDefault(value, WrittenAs(def, value.type, subject));
}

/** Reads a value as jsonb, which is the operand every container stage works from. */
export function AsJson(value: Compiled): Compiled {
  return Cast(value, OPAQUE);
}
