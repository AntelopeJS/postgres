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
  FLOAT,
  JsonOf,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

export const LAMBDA_ID_FLOOR = 0;

export const ROW_ID = LAMBDA_ID_FLOOR - 1;

export const VALUE_ID = LAMBDA_ID_FLOOR - 2;

export const SUBQUERY_ID = LAMBDA_ID_FLOOR - 3;

export const users: TableModel = {
  fields: {
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    createdAt: { column: "createdAt", type: TIMESTAMP },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
  },
};

/** JavaScript's own falsy table over a jsonb value, transcribed rather than imported. */
export const FALSEHOOD = `<> ALL (array['null', 'false', '0', '""']::jsonb[])`;

export const ELEMENT: Compiled = { sql: 'e."value"', type: TEXT };

export const SUBQUERY: Compiled = { sql: "(SELECT 1)", type: FLOAT };

export type Builder = (doc: ValueProxy<any>) => ValueProxy<any>;

export function NewContext(): DecodingContext {
  const context = new DecodingContext({
    ...RefusingCompilers(),
    expression: CompileExpression,
  });
  context.bind(ROW_ID, new ColumnRowSource(AliasedColumns("t"), users));
  context.bind(VALUE_ID, ELEMENT);
  context.bind(SUBQUERY_ID, () => SUBQUERY);
  return context;
}

export function Compile(build: Builder): Compiled {
  return CompileExpression(build(ValueProxy.arg(ROW_ID)).build(), NewContext());
}
