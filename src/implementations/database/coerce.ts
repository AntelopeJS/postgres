import type { Compiled } from "./sql";
import {
  ArrayOf,
  IsJsonBacked,
  IsOpaque,
  JsonOf,
  OPAQUE,
  PhysicalType,
  type SqlShape,
  type SqlType,
} from "./types";

export interface CompiledPair {
  left: Compiled;
  right: Compiled;
  type: SqlType;
}

/**
 * Common type for two operands of the same operator.
 *
 * The bottom type is pulled *toward* the concrete operand, which is what lets a jsonb path be
 * compared against a known type rather than as text. Bottom is therefore not absorbing — use
 * {@link UnifyAll} to join a collection of element types, where it must be.
 */
export function Unify(left: SqlType, right: SqlType): SqlType {
  if (IsOpaque(left)) {
    return right;
  }
  if (IsOpaque(right)) {
    return left;
  }
  if (left.kind === right.kind) {
    return UnifySameKind(left, right);
  }
  return OPAQUE;
}

function UnifySameKind(left: SqlType, right: SqlType): SqlType {
  if (left.kind === "array" && right.kind === "array") {
    return ArrayOf(Unify(left.elem, right.elem));
  }
  if (left.kind === "json" && right.kind === "json") {
    return JsonOf(UnifyShapes(left.shape, right.shape));
  }
  return left;
}

function UnifyShapes(left?: SqlShape, right?: SqlShape): SqlShape | undefined {
  if (!left || !right) {
    return undefined;
  }
  const shape: Record<string, SqlType> = {};
  for (const [name, type] of Object.entries(left)) {
    if (name in right) {
      shape[name] = Unify(type, right[name]);
    }
  }
  return shape;
}

export function Cast(value: Compiled, target: SqlType): Compiled {
  if (value.type.kind === target.kind) {
    return { sql: value.sql, type: target };
  }
  if (IsJsonBacked(value.type) && IsJsonBacked(target)) {
    return { sql: value.sql, type: target };
  }
  if (IsJsonBacked(target)) {
    return { sql: `to_jsonb(${value.sql})`, type: OPAQUE };
  }
  if (IsJsonBacked(value.type)) {
    return FromJson(value, target);
  }
  return { sql: `((${value.sql})::${PhysicalType(target)})`, type: target };
}

function FromJson(value: Compiled, target: SqlType): Compiled {
  const text = `(${value.sql} #>> '{}')`;
  if (target.kind === "text") {
    return { sql: text, type: target };
  }
  return { sql: `(${text}::${PhysicalType(target)})`, type: target };
}

/**
 * Element type for a collection, where the bottom type is absorbing.
 *
 * {@link Unify} alone is not associative, so folding it over three or more element types can
 * re-promote a mixed collection back to a concrete type.
 */
export function UnifyAll(types: SqlType[]): SqlType {
  if (types.length === 0) {
    return OPAQUE;
  }
  return types.reduce((left, right) =>
    IsOpaque(left) ? OPAQUE : Unify(left, right),
  );
}

export function UnifyOperands(left: Compiled, right: Compiled): CompiledPair {
  const type = Unify(left.type, right.type);
  return { left: Cast(left, type), right: Cast(right, type), type };
}

export function WithDefault(value: Compiled, def?: Compiled): Compiled {
  if (!def) {
    return value;
  }
  const pair = UnifyOperands(value, def);
  return {
    sql: `COALESCE(${pair.left.sql}, ${pair.right.sql})`,
    type: pair.type,
  };
}
