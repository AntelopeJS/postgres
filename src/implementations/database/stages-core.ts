import { type CompiledPair, UnifyOperands, WithDefault } from "./coerce";
import { AsJson, Predicate } from "./readings";
import type { Compiled } from "./sql";
import {
  BuildStages,
  FIRST_OPERAND,
  Lift,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";
import { BOOL, IsJsonBacked, IsOpaque, OPAQUE } from "./types";
import { DecodeValue, NULL_JSON } from "./value";

type Equality = (value: Compiled, other: Compiled) => Compiled;

interface EqualityOperator {
  compare: Equality;
  negated: boolean;
}

const BOOLEAN_OPERATORS: Record<string, string> = {
  and: "AND",
  or: "OR",
};

const ORDERING_OPERATORS: Record<string, string> = {
  cmp_gt: ">",
  cmp_ge: ">=",
  cmp_lt: "<",
  cmp_le: "<=",
};

const ArgStage: StageHandler = (_state, stage, context) => {
  const binding = context.arg(stage.args[FIRST_OPERAND]);
  if (typeof binding === "function") {
    return { current: binding([stage]) };
  }
  return { current: binding };
};

const ConstantStage: StageHandler = (_state, stage, context) => ({
  current: RequireOperand(
    DecodeValue(stage.args[FIRST_OPERAND], context),
    stage,
    FIRST_OPERAND,
  ),
});

/**
 * The fallback a value takes when it is null, at whatever type the two of them meet.
 * Not {@link Defaulted}: this default is an alternative value, not one of the column's type.
 */
const DefaultStage = Lift((value, args) =>
  WithDefault(value, args[FIRST_OPERAND]),
);

/**
 * Negates a condition the way JavaScript's `!` does, where the operand may be neither true nor false.
 * `NOT NULL` is NULL and would drop the row, so `IS NOT TRUE` is the total spelling.
 */
const NotStage = Lift((value) => ({
  sql: `(${Predicate(value).sql} IS NOT TRUE)`,
  type: BOOL,
}));

function BooleanStage(operator: string): StageHandler {
  return Lift((value, args, stage) => {
    const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
    return {
      sql: `(${Predicate(value).sql} ${operator} ${Predicate(other).sql})`,
      type: BOOL,
    };
  });
}

const EQUAL = "=";
const DISTINCT_FROM = "IS DISTINCT FROM";

function Comparison(
  value: Compiled,
  other: Compiled,
  operator: string,
): Compiled {
  const pair = UnifyOperands(value, other);
  return {
    sql: `(${pair.left.sql} ${operator} ${pair.right.sql})`,
    type: BOOL,
  };
}

const Identical: Equality = (value, other) => Comparison(value, other, EQUAL);

/**
 * Operands for an inequality, the one comparison that must answer for a value it cannot read.
 * Exactly one bottom-typed side compares in jsonb, where no type guard can reject the other.
 */
function Distinguishable(value: Compiled, other: Compiled): CompiledPair {
  if (IsOpaque(value.type) === IsOpaque(other.type)) {
    return UnifyOperands(value, other);
  }
  return { left: AsJson(value), right: AsJson(other), type: OPAQUE };
}

/**
 * Compares two values for inequality, keeping a row whose operand is null or absent.
 * `<>` is NULL whenever either side is, so `IS DISTINCT FROM` is the total spelling.
 */
const Distinct: Equality = (value, other) => {
  const pair = Distinguishable(value, other);
  return {
    sql: `(${pair.left.sql} ${DISTINCT_FROM} ${pair.right.sql})`,
    type: BOOL,
  };
};

const EQUALITY_OPERATORS: Record<string, EqualityOperator> = {
  eq: { compare: Identical, negated: false },
  ne: { compare: Distinct, negated: true },
};

/**
 * A json null is not SQL NULL, and a declared column holding SQL NULL is not a json null, so a
 * comparison against `null` must read both spellings rather than unify toward the operand's type.
 */
function NullTest(value: Compiled, negated: boolean): Compiled {
  const missing = `(${value.sql} IS NULL)`;
  const test = IsJsonBacked(value.type)
    ? `(${missing} OR (${value.sql} = ${NULL_JSON.sql}))`
    : missing;
  return { sql: negated ? `(NOT ${test})` : test, type: BOOL };
}

function EqualityStage(operator: EqualityOperator): StageHandler {
  return Lift((value, args, stage) => {
    const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
    if (other === NULL_JSON) {
      return NullTest(value, operator.negated);
    }
    if (value === NULL_JSON) {
      return NullTest(other, operator.negated);
    }
    return operator.compare(value, other);
  });
}

function OrderingStage(operator: string): StageHandler {
  return Lift((value, args, stage) =>
    Comparison(
      value,
      RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
      operator,
    ),
  );
}

export const CORE_STAGES: StageMap = {
  arg: ArgStage,
  constant: ConstantStage,
  default: DefaultStage,
  not: NotStage,
  ...BuildStages(BOOLEAN_OPERATORS, BooleanStage),
  ...BuildStages(EQUALITY_OPERATORS, EqualityStage),
  ...BuildStages(ORDERING_OPERATORS, OrderingStage),
};
