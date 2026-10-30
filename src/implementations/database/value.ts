import assert from "node:assert";

import { Query, ValueProxy } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { Cast, UnifyAll } from "./coerce";
import type { ArgumentBinding, DecodingContext } from "./context";
import {
  type Compiled,
  type ConstantJson,
  JSON_NULL,
  Param,
  QuoteLiteral,
} from "./sql";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "./types";
import { IsBoolean, IsNumber, IsString } from "./guards";

/**
 * The single json null every `null` in a query decodes to.
 *
 * {@link DecodeValue} returns this exact object, so an operator that needs to recognise a null
 * literal — `eq` and `ne`, which must become an `IS NULL` test rather than a comparison against
 * the bottom type — can detect it by identity.
 */
export const NULL_JSON: Compiled = { sql: JSON_NULL, type: OPAQUE };

/**
 * Turn a value handed to the query builder into a SQL fragment.
 *
 * `undefined` decodes to `undefined` — absence, which the caller interprets — while `null`
 * decodes to a json null, since a jsonb member set to null is not SQL NULL.
 *
 * Every case here that *recurses* — an array, a plain object, and a `StagedObject` handed to a
 * compiler — must stay covered by `selection.ts`'s `CollectValue`, the pre-pass that gates schema
 * readiness by walking the same shapes before any of this runs. A recursive case
 * added here and missed there compiles against a shape that has not converged, and the failure
 * surfaces nowhere near this file. The final refusal of every other value, objects included, is
 * what keeps that obligation checkable rather than a matter of trust.
 */
export function DecodeValue(
  value: unknown,
  context: DecodingContext,
): Compiled | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return NULL_JSON;
  }
  if (value instanceof ValueProxy) {
    return context.expression(value.build());
  }
  if (value instanceof Query) {
    return context.subquery(value.build());
  }
  if (value instanceof Date) {
    return Param(context.params, value, TIMESTAMP);
  }
  if (Array.isArray(value)) {
    return DecodeArray(value, context);
  }
  if (IsPlainObject(value)) {
    return DecodeObject(value, context);
  }
  if (IsString(value)) {
    return Param(context.params, value, TEXT);
  }
  if (IsNumber(value)) {
    return Param(context.params, value, FLOAT);
  }
  if (IsBoolean(value)) {
    return Param(context.params, value, BOOL);
  }
  throw new Error(`Unsupported value of type '${typeof value}' in query`);
}

/**
 * Whether a value is an object literal rather than an instance of something.
 *
 * The distinction is what tells a document apart from a `ValueProxy`, which is an object too: a
 * membership test that only asked whether the value is an object would read a recorded expression
 * as a document of the keys its class happens to carry.
 */
export function IsPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Whether a value is json the driver can send whole, rather than an expression to compile.
 *
 * A `ValueProxy` or a `Query` reads the row and has to be emitted as SQL; a `Date` is deliberately
 * excluded because `to_jsonb(timestamptz)` and `JSON.stringify` do not spell the same instant.
 */
function IsConstantJson(value: unknown): value is ConstantJson {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(IsConstantJson);
  }
  if (IsPlainObject(value)) {
    return Object.values(value).every(
      (item) => item === undefined || IsConstantJson(item),
    );
  }
  return IsString(value) || IsNumber(value) || IsBoolean(value);
}

/**
 * The type {@link DecodeValue} would give a constant, read off the value instead of the SQL.
 *
 * Mirrors the three decoders below it, so that binding a constant whole does not change the type
 * the caller sees — only the number of parameters it takes.
 */
function ConstantType(value: ConstantJson): SqlType {
  if (value === null) {
    return NULL_JSON.type;
  }
  if (Array.isArray(value)) {
    return ArrayOf(UnifyAll(value.map(ConstantType)));
  }
  if (IsString(value)) {
    return TEXT;
  }
  if (IsNumber(value)) {
    return FLOAT;
  }
  if (IsBoolean(value)) {
    return BOOL;
  }
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item !== undefined) {
      keyTypes[name] = ConstantType(item);
    }
  }
  return JsonOf(keyTypes);
}

/**
 * A list of constants binds as one jsonb parameter, where a list of expressions cannot.
 *
 * `jsonb_build_array` takes one argument per element and PostgreSQL caps a function call at 100,
 * so a literal list longer than that loses the whole statement — and the lists callers pass are
 * the ones they did not count, like every route of an application. Sending the array itself keeps
 * the same value, the same type, and one parameter whatever its length.
 */
function DecodeArray(values: unknown[], context: DecodingContext): Compiled {
  if (values.every(IsConstantJson)) {
    const type = ArrayOf(UnifyAll(values.map(ConstantType)));
    return { sql: Param(context.params, values, OPAQUE).sql, type };
  }
  const items = values.map((item) => DecodeValue(item, context) ?? NULL_JSON);
  const elem = UnifyAll(items.map((item) => item.type));
  const parts = items.map((item) => Cast(item, OPAQUE).sql);
  return { sql: `jsonb_build_array(${parts.join(", ")})`, type: ArrayOf(elem) };
}

function DecodeObject(
  value: Record<string, unknown>,
  context: DecodingContext,
): Compiled {
  const parts: string[] = [];
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, item] of Object.entries(value)) {
    const compiled = DecodeValue(item, context);
    if (!compiled) {
      continue;
    }
    parts.push(QuoteLiteral(name), Cast(compiled, OPAQUE).sql);
    keyTypes[name] = compiled.type;
  }
  return {
    sql: `jsonb_build_object(${parts.join(", ")})`,
    type: JsonOf(keyTypes),
  };
}

const FUNCTION_STAGE = "func";
const PARAMETER_IDS = 0;
const FUNCTION_BODY = 1;

/** A lambda the query builder recorded: the ids of its parameters, then the body they are bound in. */
export interface RecordedFunction extends QueryStage {
  stage: typeof FUNCTION_STAGE;
  args: [ids: number[], body: unknown];
}

/**
 * Whether a value is a lambda a caller recorded, for a stage that accepts either a lambda or a plain
 * document.
 *
 * The query builder records one as `{ stage: "func", args: [[argId], body] }` — a plain object
 * carrying no marker class — so `update`, the one stage taking either, can only tell them apart by
 * shape. The parameter-id list is read as well as the stage name because it is the half no
 * caller's own document plausibly carries: testing the stage name alone refuses
 * `{ stage: "func", args: [1] }`, which is a legitimate document of two undeclared keys, while a
 * test that missed a lambda would store `stage` and `args` in the row as ordinary keys. Every read
 * goes through {@link IsPlainObject} first, so the shape is tested rather than asserted. It narrows
 * the value to the stage it tested, so a caller that goes on to compile the body reaches
 * {@link DecodeFunction} without asserting the same shape a second time.
 */
export function IsRecordedFunction(value: unknown): value is RecordedFunction {
  if (!IsPlainObject(value) || value.stage !== FUNCTION_STAGE) {
    return false;
  }
  const args: unknown = value.args;
  if (!Array.isArray(args)) {
    return false;
  }
  const ids: unknown = args[PARAMETER_IDS];
  return Array.isArray(ids) && ids.every(IsNumber);
}

/**
 * The lambda a stage records as its argument at `index`.
 *
 * `map`, `filter` and the other callback stages take nothing else, and the builder always records
 * one, so a stage that carries any other value is refused here by name rather than failing on
 * whatever the compiler reads from it first.
 */
export function RecordedLambda(
  stage: QueryStage,
  index: number,
): RecordedFunction {
  const lambda: unknown = stage.args[index];
  assert(
    IsRecordedFunction(lambda),
    `Stage '${stage.stage}' requires a callback at position ${index}`,
  );
  return lambda;
}

/** Whatever a recorded lambda returned, which is a value for most callers and a document for one. */
export function FunctionBody(func: RecordedFunction): unknown {
  return func.args[FUNCTION_BODY];
}

/**
 * Runs a compilation with a recorded lambda's parameters bound to the given row sources or
 * subquery providers, and unbound again however it ends.
 *
 * Separate from {@link DecodeFunction} because a lambda's body is not always compiled as a value:
 * `update`'s mapper may return a document, whose keys are split into per-column assignments and
 * whose *values* are the recorded expressions — so the binding has to span a walk of the body
 * rather than one decode of it. Decoding such a body as a value instead would build the whole
 * document as one jsonb object and lose the columns.
 */
export function WithBoundArguments<T>(
  func: RecordedFunction,
  context: DecodingContext,
  bindings: ArgumentBinding[],
  compile: () => T,
): T {
  const ids = func.args[PARAMETER_IDS];
  const missing = ids.findIndex((_, index) => !bindings[index]);
  if (missing >= 0) {
    throw new Error(`Missing binding for lambda parameter ${missing}`);
  }
  ids.forEach((id, index) => {
    context.bind(id, bindings[index]);
  });
  try {
    return compile();
  } finally {
    ids.forEach((id) => {
      context.unbind(id);
    });
  }
}

/**
 * Decode the body of a lambda recorded by the query builder, with its parameters bound to the
 * given row sources or subquery providers for the duration of the decode.
 */
export function DecodeFunction(
  func: RecordedFunction,
  context: DecodingContext,
  bindings: ArgumentBinding[],
): Compiled | undefined {
  return WithBoundArguments(func, context, bindings, () =>
    DecodeValue(FunctionBody(func), context),
  );
}
