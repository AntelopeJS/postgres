import type { Compiled } from "./sql";
import { AsJson, Predicate } from "./readings";
import { DecodeValue, NULL_JSON } from "./value";
import { BOOL, IsJsonBacked, IsOpaque, OPAQUE } from "./types";
import { type CompiledPair, UnifyOperands, WithDefault } from "./coerce";
import {
  ArgumentId,
  BuildStages,
  FIRST_OPERAND,
  Lift,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";
import { IsSubqueryProvider } from "./context";

type Equality = (value: Compiled, other: Compiled) => Compiled;

interface EqualityOperator {
  compare: Equality;
  negated: boolean;
}

const BOOLEAN_OPERATORS = {
  and: "AND",
  or: "OR",
};

const ORDERING_OPERATORS = {
  cmp_gt: ">",
  cmp_ge: ">=",
  cmp_lt: "<",
  cmp_le: "<=",
};

const ArgStage: StageHandler = (_state, stage, context) => {
  const binding = context.arg(ArgumentId(stage));
  if (IsSubqueryProvider(binding)) {
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
  const pair = UnifyOperands(value, other, operator);
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
 *
 * Against a converted operand it is the complement of equality instead: the conversion answers
 * NULL for a value the column's type cannot hold, and `IS DISTINCT FROM NULL` would then drop every
 * row whose column is NULL — rows that are as unequal to that value as any other.
 */
const Distinct: Equality = (value, other) => {
  const pair = Distinguishable(value, other);
  if (pair.converted) {
    return {
      sql: `((${pair.left.sql} ${EQUAL} ${pair.right.sql}) IS NOT TRUE)`,
      type: BOOL,
    };
  }
  return {
    sql: `(${pair.left.sql} ${DISTINCT_FROM} ${pair.right.sql})`,
    type: BOOL,
  };
};

const EQUALITY_OPERATORS = {
  eq: { compare: Identical, negated: false },
  ne: { compare: Distinct, negated: true },
} satisfies Record<string, EqualityOperator>;

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
