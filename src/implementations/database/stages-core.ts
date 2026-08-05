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

const DefaultStage = Lift((value, args) =>
  WithDefault(value, args[FIRST_OPERAND]),
);

/**
 * Negates a condition the way JavaScript's `!` does, where the operand may be neither true nor
 * false.
 *
 * `NOT NULL` is NULL, so a plain negation of a missing or wrong-typed key answers null and the row
 * is dropped from the `WHERE` that reads it — while `!undefined` is `true`. `IS NOT TRUE` is the
 * total spelling: it answers true for both null and false, and is the same answer as `NOT` wherever
 * the operand is known.
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
 * Operands for an inequality, which is the one comparison that has to answer for a value it cannot
 * read.
 *
 * {@link UnifyOperands} pulls a bottom-typed side toward the concrete one, and the projection that
 * does it is guarded: a stored value of some other type reads as NULL, and the inequality then
 * answers null rather than *unequal*. Where exactly one side is bottom-typed the comparison
 * therefore happens in jsonb instead, which compares the two values as they are stored and has no
 * type for the guard to reject. Both sides already agreeing — two bottom types or two concrete ones
 * — leaves nothing to guard, so those keep the unified reading.
 */
function Distinguishable(value: Compiled, other: Compiled): CompiledPair {
  if (IsOpaque(value.type) === IsOpaque(other.type)) {
    return UnifyOperands(value, other);
  }
  return { left: AsJson(value), right: AsJson(other), type: OPAQUE };
}

/**
 * Compares two values for inequality, keeping a row whose operand is null or absent.
 *
 * `<>` is NULL whenever either side is, so a row with no such key is dropped from the `WHERE` that
 * reads it — while the contract, and both sibling backends, count a value that is not there as
 * unequal to one that is. `IS DISTINCT FROM` is the total spelling.
 *
 * The only cost is btree reachability, and it is theoretical: `ne` on an indexed column selects
 * most of the table, so no planner reaches for an index to answer it.
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
