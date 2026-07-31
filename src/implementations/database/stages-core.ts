import { UnifyOperands, WithDefault } from "./coerce";
import type { Compiled } from "./sql";
import {
  BuildStages,
  FIRST_OPERAND,
  Lift,
  Predicate,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";
import { BOOL, IsJsonBacked } from "./types";
import { DecodeValue, NULL_JSON } from "./value";

interface EqualityOperator {
  infix: string;
  negated: boolean;
}

const BOOLEAN_OPERATORS: Record<string, string> = {
  and: "AND",
  or: "OR",
};

const EQUALITY_OPERATORS: Record<string, EqualityOperator> = {
  eq: { infix: "=", negated: false },
  ne: { infix: "<>", negated: true },
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

const NotStage = Lift((value) => ({
  sql: `(NOT ${Predicate(value).sql})`,
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
    return Comparison(value, other, operator.infix);
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
