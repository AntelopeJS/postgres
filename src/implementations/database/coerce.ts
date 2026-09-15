import { type Compiled, JSON_NULL, QuoteLiteral } from "./sql";
import {
  ArrayOf,
  IsJsonBacked,
  IsOpaque,
  JsonOf,
  OPAQUE,
  PhysicalType,
  ShapeOf,
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
    if (Object.hasOwn(right, name)) {
      shape[name] = Unify(type, right[name]);
    }
  }
  return Object.keys(shape).length > 0 ? shape : undefined;
}

/**
 * Common type for values that arrive from *alternative* sources, such as the two halves of a
 * union.
 *
 * Where {@link Unify} intersects two json shapes — right for two operands of one operator, since
 * a key only one side declares cannot take part in the comparison — this takes their union,
 * because every row comes from exactly one side and carries that side's keys. Picking the wrong
 * one is silent: an intersection drops the type of a key that is genuinely present in the rows,
 * and the value then decodes as raw json.
 *
 * Only the shape rule differs. Anything else — two scalars, two arrays, a shaped side against an
 * unshaped one — is {@link Unify}, so two streams of the same concrete kind widen to that kind
 * rather than to the bottom type they would then have to decode as raw json.
 */
export function Widen(left: SqlType, right: SqlType): SqlType {
  const leftShape = ShapeOf(left);
  const rightShape = ShapeOf(right);
  if (!leftShape || !rightShape) {
    return Unify(left, right);
  }
  const shape: Record<string, SqlType> = { ...leftShape };
  for (const [name, type] of Object.entries(rightShape)) {
    shape[name] = Object.hasOwn(leftShape, name)
      ? Unify(leftShape[name], type)
      : type;
  }
  return JsonOf(shape);
}

/**
 * Rewrites a value as the target type.
 *
 * Projecting *out* of jsonb is guarded by `jsonb_typeof`, so a key whose stored values are
 * heterogeneous yields NULL for the ones that do not fit rather than failing the whole
 * statement. A `timestamp` target carries a second guard, since `jsonb_typeof` only proves the
 * value is a string and `'"hello"'::jsonb #>> '{}'` read as a date raises `22007` and kills the
 * statement: the projection is offered to PostgreSQL's own input function first, which is the
 * same test {@link ParsesAs} applies to a declared `text` operand. One residue survives — a jsonb
 * number too large for `double precision` still raises `22003` — and it is not reachable through
 * this adapter's own write path.
 *
 * The guard makes a coercion that PostgreSQL's input parsers would have accepted — the string
 * `"42"` read as a number, the number `1` read as a boolean, the number `42` read as the text
 * `'42'` — yield NULL instead. That is deliberate: the contract compares values of different
 * types as unequal, and `#>> '{}'` being total is exactly what would make `eq("42")` match a
 * stored number. The text projection therefore sits under the same guard as the others, on
 * `'string'`, and needs no `::text` cast because `#>>` already yields text.
 */
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

const JSON_TYPEOF: Partial<Record<SqlType["kind"], string>> = {
  float: "number",
  bool: "boolean",
  text: "string",
  timestamp: "string",
};

const PARSED_KINDS: Partial<Record<SqlType["kind"], true>> = {
  timestamp: true,
};

/**
 * Tests a text expression against PostgreSQL's own input function for a type, which is the only
 * total test of "would this cast succeed" the server offers.
 *
 * Wider than JavaScript's `Date.parse` for a `timestamp` target: `now`, `today`, `tomorrow`,
 * `yesterday`, `epoch`, `infinity` and `-infinity` are all accepted spellings.
 */
export function ParsesAs(sql: string, target: SqlType): string {
  return `pg_input_is_valid(${sql}, ${QuoteLiteral(PhysicalType(target))})`;
}

function ProjectedText(value: Compiled): string {
  return `(${value.sql} #>> '{}')`;
}

function Projection(value: Compiled, target: SqlType): string {
  const text = ProjectedText(value);
  if (target.kind === "text") {
    return text;
  }
  return `(${text}::${PhysicalType(target)})`;
}

function JsonGuards(
  value: Compiled,
  target: SqlType,
  expected: string,
): string {
  const guards = [`jsonb_typeof(${value.sql}) = '${expected}'`];
  if (PARSED_KINDS[target.kind]) {
    guards.push(ParsesAs(ProjectedText(value), target));
  }
  return guards.join(" AND ");
}

function FromJson(value: Compiled, target: SqlType): Compiled {
  const projection = Projection(value, target);
  const expected = JSON_TYPEOF[target.kind];
  if (!expected) {
    return { sql: projection, type: target };
  }
  return {
    sql: `(CASE WHEN ${JsonGuards(value, target, expected)} THEN ${projection} END)`,
    type: target,
  };
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
    IsOpaque(left) || IsOpaque(right) ? OPAQUE : Unify(left, right),
  );
}

export function UnifyOperands(left: Compiled, right: Compiled): CompiledPair {
  const type = Unify(left.type, right.type);
  return { left: Cast(left, type), right: Cast(right, type), type };
}

/**
 * The absence a default answers, which a jsonb-backed operand spells two ways.
 * A stored json null is `'null'::jsonb` rather than SQL NULL, so `COALESCE` alone never fires.
 */
function Absent(pair: CompiledPair): string {
  if (!IsJsonBacked(pair.type)) {
    return pair.left.sql;
  }
  return `NULLIF(${pair.left.sql}, ${JSON_NULL})`;
}

/**
 * Common type for a value and the default standing in for its absence.
 * Not {@link Unify}: a jsonb-backed value keeps its kind and the default is lifted to jsonb.
 */
function DefaultType(value: SqlType, def: SqlType): SqlType {
  if (IsJsonBacked(value) && value.kind !== def.kind) {
    return OPAQUE;
  }
  return Unify(value, def);
}

export function WithDefault(value: Compiled, def?: Compiled): Compiled {
  if (!def) {
    return value;
  }
  const type = DefaultType(value.type, def.type);
  const pair: CompiledPair = {
    left: Cast(value, type),
    right: Cast(def, type),
    type,
  };
  return {
    sql: `COALESCE(${Absent(pair)}, ${pair.right.sql})`,
    type: pair.type,
  };
}
