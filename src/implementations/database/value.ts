import { Query, ValueProxy } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { Cast, UnifyAll } from "./coerce";
import type { ArgumentBinding, DecodingContext } from "./context";
import { type Compiled, Param, QuoteLiteral } from "./sql";
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

const PRIMITIVE_TYPES: Record<string, SqlType> = {
  string: TEXT,
  number: FLOAT,
  boolean: BOOL,
};

const NULL_JSON: Compiled = { sql: "'null'::jsonb", type: OPAQUE };

/**
 * Turn a value handed to the query builder into a SQL fragment.
 *
 * `undefined` decodes to `undefined` — absence, which the caller interprets — while `null`
 * decodes to a json null, since a jsonb member set to null is not SQL NULL.
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
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return DecodeObject(value as Record<string, unknown>, context);
  }
  return DecodePrimitive(value, context);
}

function DecodePrimitive(value: unknown, context: DecodingContext): Compiled {
  const type = PRIMITIVE_TYPES[typeof value];
  if (!type) {
    throw new Error(`Unsupported value of type '${typeof value}' in query`);
  }
  return Param(context.params, value, type);
}

function DecodeArray(values: unknown[], context: DecodingContext): Compiled {
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
  const shape: Record<string, SqlType> = {};
  for (const [name, item] of Object.entries(value)) {
    const compiled = DecodeValue(item, context);
    if (!compiled) {
      continue;
    }
    parts.push(QuoteLiteral(name), Cast(compiled, OPAQUE).sql);
    shape[name] = compiled.type;
  }
  return {
    sql: `jsonb_build_object(${parts.join(", ")})`,
    type: JsonOf(shape),
  };
}

/**
 * Decode the body of a lambda recorded by the query builder, with its parameters bound to the
 * given row sources or subquery providers for the duration of the decode.
 */
export function DecodeFunction(
  func: QueryStage,
  context: DecodingContext,
  bindings: ArgumentBinding[],
): Compiled | undefined {
  const ids: number[] = func.args[0];
  ids.forEach((id, index) => {
    const binding = bindings[index];
    if (!binding) {
      throw new Error(`Missing binding for lambda parameter ${index}`);
    }
    context.bind(id, binding);
  });
  try {
    return DecodeValue(func.args[1], context);
  } finally {
    ids.forEach((id) => {
      context.unbind(id);
    });
  }
}
