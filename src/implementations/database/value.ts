import assert from "node:assert";

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
import {
  ClassifyMember,
  IsPlainObject,
  type ListMember,
  type Member,
} from "./member";

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
  value: Member,
  context: DecodingContext,
): Compiled | undefined {
  switch (value.kind) {
    case "absent":
      return undefined;
    case "null":
      return NULL_JSON;
    case "proxy":
      return context.expression(value.value.build());
    case "query":
      return context.subquery(value.value.build());
    case "date":
      return Param(context.params, value.value, TIMESTAMP);
    case "list":
      return DecodeArray(value, context);
    case "record":
      return DecodeEntries(value.document.entries(), context);
    case "text":
      return Param(context.params, value.value, TEXT);
    case "number":
      return Param(context.params, value.value, FLOAT);
    case "boolean":
      return Param(context.params, value.value, BOOL);
    case "staged":
    case "opaque":
      throw new Error(`Unsupported value of type '${value.typeName}' in query`);
  }
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
function DecodeArray(list: ListMember, context: DecodingContext): Compiled {
  const constant = list.constant();
  if (constant) {
    const type = ArrayOf(UnifyAll(constant.map(ConstantType)));
    return { sql: Param(context.params, constant, OPAQUE).sql, type };
  }
  const items = list
    .items()
    .map((item) => DecodeValue(item, context) ?? NULL_JSON);
  const elem = UnifyAll(items.map((item) => item.type));
  const parts = items.map((item) => Cast(item, OPAQUE).sql);
  return { sql: `jsonb_build_array(${parts.join(", ")})`, type: ArrayOf(elem) };
}

/** A document built from named members, each cast to jsonb; an absent member is left out. */
export function DecodeEntries(
  entries: [string, Member][],
  context: DecodingContext,
): Compiled {
  const parts: string[] = [];
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, item] of entries) {
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
export const FUNCTION_BODY = 1;

/** A lambda the query builder recorded: the ids of its parameters, then the body they are bound in. */
export interface RecordedFunction {
  stage: typeof FUNCTION_STAGE;
  args: [ids: unknown[], body: unknown];
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
  return IsLambdaStage(value) && value.args[PARAMETER_IDS].every(IsNumber);
}

/**
 * Whether a value is a `func` stage whose parameter ids are a list. A stage that takes only a
 * callback accepts whatever ids a `func` rebuilt from JSON may carry, which the adapter has always
 * bound by their property-key text; {@link IsRecordedFunction} stays strict because `update` has to
 * tell a lambda from a document.
 */
function IsLambdaStage(value: unknown): value is RecordedFunction {
  if (!IsPlainObject(value) || value.stage !== FUNCTION_STAGE) {
    return false;
  }
  const args: unknown = value.args;
  if (!Array.isArray(args)) {
    return false;
  }
  const ids: unknown = args[PARAMETER_IDS];
  return Array.isArray(ids);
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
  assert(IsLambdaStage(lambda), `Stage '${stage.stage}' requires a callback`);
  return lambda;
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
    context.bind(String(id), bindings[index]);
  });
  try {
    return compile();
  } finally {
    ids.forEach((id) => {
      context.unbind(String(id));
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
    DecodeValue(ClassifyMember(func.args[FUNCTION_BODY]), context),
  );
}
