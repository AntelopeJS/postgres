import { ValueProxy } from "@antelopejs/interface-database";

import { RefusingCompilers } from "./spec-fixture";
import type { Compiled } from "../../implementations/database/sql";
import type { TableModel } from "../../implementations/database/fields";
import { DecodingContext } from "../../implementations/database/context";
import { CompileExpression } from "../../implementations/database/expression";
import {
  AliasedColumns,
  ColumnRowSource,
} from "../../implementations/database/row-source";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

export const LAMBDA_ID_FLOOR = 0;

export const ROW_ID = LAMBDA_ID_FLOOR - 1;

export const users: TableModel = {
  fields: {
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    tags: { column: "tags", type: ArrayOf(TEXT) },
    scores: { column: "scores", type: ArrayOf(FLOAT) },
    visits: { column: "visits", type: ArrayOf(TIMESTAMP) },
    entries: { column: "entries", type: ArrayOf(JsonOf({ at: TIMESTAMP })) },
    flags: { column: "flags", type: ArrayOf(BOOL) },
    nested: { column: "nested", type: ArrayOf(ArrayOf(FLOAT)) },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
  },
};

export type Builder = (doc: any) => any;

export function NewContext(): DecodingContext {
  const context = new DecodingContext({
    ...RefusingCompilers(),
    expression: CompileExpression,
  });
  context.bind(ROW_ID, new ColumnRowSource(AliasedColumns("t"), users));
  return context;
}

export function Compile(build: Builder): Compiled {
  return CompileExpression(build(ValueProxy.arg(ROW_ID)).build(), NewContext());
}

export const TAGS = `"t"."tags"`;

export const EXTRA = `("t"."_extra" -> 'nope')`;

export function Guarded(operand: string, body: string): string {
  return `(CASE WHEN jsonb_typeof(${operand}) = 'array' THEN ${body} END)`;
}

export function AsText(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' THEN (${sql} #>> '{}') END)`;
}

export function Element(alias: string): string {
  return `"${alias}"."value"`;
}

export function Walk(
  operand: string,
  alias: string,
  aggregate: string,
  where = "",
): string {
  const columns = `AS "${alias}"("value", "ord")`;
  const source = `jsonb_array_elements(${operand}) WITH ORDINALITY ${columns}`;
  return `(SELECT ${aggregate} FROM ${source}${where})`;
}

export function Collected(alias: string, target: string): string {
  return `COALESCE(jsonb_agg(${target} ORDER BY "${alias}"."ord"), '[]'::jsonb)`;
}

export const FLOAT_PARAM = "($1::double precision)";
