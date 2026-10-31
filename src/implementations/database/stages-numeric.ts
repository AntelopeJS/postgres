import type { QueryStage } from "@antelopejs/interface-database/common";
import { OptionsOf } from "./utils";

import { Unify } from "./coerce";
import type { Compiled } from "./sql";
import { FLOAT, type SqlType, TEXT, TIMESTAMP } from "./types";
import { AsFloat, FLOAT_CAST, Moment, Numeric, Text } from "./readings";
import {
  FIRST_OPERAND,
  Lift,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";

type Arithmetic = (
  left: Compiled,
  right: Compiled,
  stage: QueryStage,
) => Compiled;

type OperandTable = Record<string, Arithmetic | null>;

type Rounding = (sql: string) => string;

interface OperandKinds {
  left: SqlType["kind"];
  right: SqlType["kind"];
  key: string;
}

const PLUS = "+";
const MINUS = "-";
const TIMES = "*";
const OVER = "/";
const BIT_AND = "&";
const BIT_OR = "|";
const BIT_XOR = "#";
const SHIFT_LEFT = "<<";
const SHIFT_RIGHT = ">>";

const ONE_SECOND = "interval '1 second'";
const HALF = "0.5";
const ZERO = "0";
const INT32_MODULUS = "4294967296";
const UINT32_MASK = "4294967295";
const SHIFT_MASK = "31";
const NOT_A_NUMBER = "'NaN'::float8";
const POSITIVE_INFINITY = "'Infinity'::float8";
const NEGATIVE_INFINITY = "'-Infinity'::float8";

function OffsetMoment(
  moment: Compiled,
  seconds: Compiled,
  operator: string,
): Compiled {
  return {
    sql: `(${Moment(moment).sql} ${operator} (${Numeric(seconds).sql}) * ${ONE_SECOND})`,
    type: TIMESTAMP,
  };
}

const ElapsedSeconds: Arithmetic = (left, right) => ({
  sql: `(EXTRACT(EPOCH FROM (${Moment(left).sql} - ${Moment(right).sql}))${FLOAT_CAST})`,
  type: FLOAT,
});

const ConcatText: Arithmetic = (left, right) => ({
  sql: `(${Text(left).sql} || ${Text(right).sql})`,
  type: TEXT,
});

/** A json `null` operand answers NULL, as every other `add` does, instead of becoming an element. */
const ConcatArray: Arithmetic = (left, right) => ({
  sql: `(${left.sql} || NULLIF(${right.sql}, 'null'::jsonb))`,
  type: Unify(left.type, right.type),
});

const NO_READING = null;

/** A divisor that is zero read as absent, so the row yields NULL — see {@link NUMERIC_STAGES}. */
function NonZero(sql: string): string {
  return `NULLIF(${sql}, ${ZERO})`;
}

const Modulo: Arithmetic = (left, right) => ({
  sql: `(mod((${Numeric(left).sql})::numeric, ${NonZero(`(${Numeric(right).sql})::numeric`)})${FLOAT_CAST})`,
  type: FLOAT,
});

const Divide: Arithmetic = (left, right) => ({
  sql: `(${Numeric(left).sql} ${OVER} ${NonZero(Numeric(right).sql)})`,
  type: FLOAT,
});

function Infix(operator: string): Arithmetic {
  return (left, right) => ({
    sql: `(${Numeric(left).sql} ${operator} ${Numeric(right).sql})`,
    type: FLOAT,
  });
}

const ADD_OPERANDS = {
  "timestamp:float": (left, right) => OffsetMoment(left, right, PLUS),
  "float:timestamp": (left, right) => OffsetMoment(right, left, PLUS),
  "timestamp:timestamp": NO_READING,
  "text:text": ConcatText,
  "array:array": ConcatArray,
} satisfies OperandTable;

const SUB_OPERANDS = {
  "timestamp:float": (left, right) => OffsetMoment(left, right, MINUS),
  "float:timestamp": NO_READING,
  "timestamp:timestamp": ElapsedSeconds,
  "text:text": NO_READING,
  "array:array": NO_READING,
} satisfies OperandTable;

const BOTTOM_PULL: Partial<Record<SqlType["kind"], SqlType["kind"]>> = {
  timestamp: "float",
};

function ResolvedKind(type: SqlType, other: SqlType): SqlType["kind"] {
  if (type.kind !== "json") {
    return type.kind;
  }
  return BOTTOM_PULL[other.kind] ?? other.kind;
}

function ResolveOperands(left: Compiled, right: Compiled): OperandKinds {
  const leftKind = ResolvedKind(left.type, right.type);
  const rightKind = ResolvedKind(right.type, left.type);
  return { left: leftKind, right: rightKind, key: `${leftKind}:${rightKind}` };
}

function BinaryStage(build: Arithmetic): StageHandler {
  return Lift((value, args, stage) =>
    build(
      value,
      RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
      stage,
    ),
  );
}

function PolymorphicStage(
  operands: OperandTable,
  fallback: Arithmetic,
): StageHandler {
  return BinaryStage((left, right, stage) => {
    const kinds = ResolveOperands(left, right);
    const build = Object.hasOwn(operands, kinds.key)
      ? operands[kinds.key]
      : fallback;
    if (!build) {
      throw new Error(
        `Stage '${stage.stage}' has no reading for a '${kinds.left}' and a '${kinds.right}'`,
      );
    }
    return build(left, right, stage);
  });
}

const NEAREST_INTEGER: Rounding = (sql) => `(floor((${sql}) + ${HALF}))`;
const UPPER_INTEGER: Rounding = (sql) => `(ceil(${sql}))`;
const LOWER_INTEGER: Rounding = (sql) => `(floor(${sql}))`;

function RoundingStage(round: Rounding): StageHandler {
  return Lift((value) => ({ sql: round(Numeric(value).sql), type: FLOAT }));
}

function Finite(sql: string): string {
  const withoutNaN = `NULLIF(${sql}, ${NOT_A_NUMBER})`;
  const withoutPositive = `NULLIF(${withoutNaN}, ${POSITIVE_INFINITY})`;
  return `NULLIF(${withoutPositive}, ${NEGATIVE_INFINITY})`;
}

function Int32(value: Compiled): string {
  const finite = Finite(Numeric(value).sql);
  return `(mod(trunc(${finite})::numeric, ${INT32_MODULUS}::numeric)::bigint::bit(32)::int)`;
}

function Uint32(value: Compiled): string {
  return `(${Int32(value)}::bigint ${BIT_AND} ${UINT32_MASK})`;
}

function ShiftCount(count: Compiled): string {
  return `(${Int32(count)} ${BIT_AND} ${SHIFT_MASK})`;
}

function BitwiseStage(operator: string): StageHandler {
  return BinaryStage((left, right) =>
    AsFloat(`${Int32(left)} ${operator} ${Int32(right)}`),
  );
}

const BitNotStage = Lift((value) => AsFloat(`~${Int32(value)}`));

const BitLshiftStage = BinaryStage((left, right) =>
  AsFloat(`${Int32(left)} ${SHIFT_LEFT} ${ShiftCount(right)}`),
);

const BitRshiftStage = BinaryStage((left, right, stage) => {
  const preserveSign: unknown = OptionsOf(stage)?.preserveSign;
  const shifted = preserveSign ? Int32(left) : Uint32(left);
  return AsFloat(`${shifted} ${SHIFT_RIGHT} ${ShiftCount(right)}`);
});

/**
 * Arithmetic and bitwise stages.
 *
 * Three of these have a spelling that looks needlessly indirect and is not:
 *
 * - `mod` routes through `numeric` because `double precision` has no `%` operator at all.
 * - `round` is `floor(x + 0.5)` because PostgreSQL's `round(double precision)` is banker's
 *   rounding — `round(2.5)` is `2` — while the contract's callers assert `Math.round`.
 *   `round(x::numeric)` rounds half away from zero, which disagrees on negatives instead.
 * - the int32 reduction behind every bitwise stage takes the modulus of the *truncated* operand
 *   rather than casting to `bigint`, so it agrees with JavaScript's `ToInt32` well past the
 *   int32 range where a plain `::bigint` silently diverges. The agreement is exact for an
 *   operand exactly representable as a double and approximate above `2^53`, where
 *   `float8::numeric` round-trips through the shortest decimal spelling rather than the exact
 *   binary value. It departs from `ToInt32` deliberately on `NaN` and `±Infinity`: those yield
 *   NULL, not `0`, because the conversion chain would otherwise raise `22003` and lose the
 *   whole statement.
 *
 * **`div` and `mod` read a zero divisor as absent**, through `NULLIF`, so the row answers NULL. A
 * bare `/` and a bare `mod()` both raise `22012 division by zero`, which loses the whole statement
 * and every other row with it — the same failure the int32 chain guards `22003` against one
 * paragraph above, and the reason the rule is *guard against failure*. It is not an
 * attempt to reproduce JavaScript, where `1/0` is `Infinity` and `1%0` is `NaN`: neither is
 * representable in `double precision` here, and NULL is what every other unreadable operand in
 * this compiler already answers. The guard is on the divisor alone, so it cannot cost an index —
 * a divisor is never the indexable side of a comparison.
 *
 * `add` and `sub` dispatch on the operand kinds *before* unifying, because two distinct
 * concrete kinds unify to the bottom type — which would compare a date against a number as
 * jsonb rather than reading the number as seconds. A bottom-typed operand is resolved toward
 * the other side first, except against a `timestamp`, where it resolves to `float`: seconds is
 * the only reading `add` and `sub` share for a date, and it degrades to NULL for an operand
 * that is not a number instead of rejecting the pair outright.
 */
export const NUMERIC_STAGES: StageMap = {
  add: PolymorphicStage(ADD_OPERANDS, Infix(PLUS)),
  sub: PolymorphicStage(SUB_OPERANDS, Infix(MINUS)),
  mul: BinaryStage(Infix(TIMES)),
  div: BinaryStage(Divide),
  mod: BinaryStage(Modulo),
  round: RoundingStage(NEAREST_INTEGER),
  ceil: RoundingStage(UPPER_INTEGER),
  floor: RoundingStage(LOWER_INTEGER),
  bit_and: BitwiseStage(BIT_AND),
  bit_or: BitwiseStage(BIT_OR),
  bit_xor: BitwiseStage(BIT_XOR),
  bit_not: BitNotStage,
  bit_lshift: BitLshiftStage,
  bit_rshift: BitRshiftStage,
};
