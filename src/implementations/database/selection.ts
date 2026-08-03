import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";
import type { DecodingContext } from "./context";
import { IndexFields } from "./ddl";
import { TableReference } from "./identifier";
import { type Relation, type TableOrigin, TableRelation } from "./relation";
import { GetIndex, GetTableShape } from "./schema";
import { Param, QualifiedColumn } from "./sql";
import { TEXT } from "./types";
import { DEFAULT_INSTANCE_ID, INSTANCE_COLUMN, type QueryStage } from "./utils";

export const SCHEMA_STAGE = "schema";
const INSTANCE_STAGE = "instance";
const TABLE_STAGE = "table";

const ROOT_STAGES: readonly string[] = [
  SCHEMA_STAGE,
  INSTANCE_STAGE,
  TABLE_STAGE,
];

export interface RootSelection {
  relation: Relation;
  rest: QueryStage[];
}

/**
 * Answers what a relation needs to know about a table it has not read yet.
 *
 * Injected on the {@link DecodingContext} rather than imported, so the pipeline can be compiled
 * against a stubbed shape: {@link RegisteredOrigin} reads the live schema registry, which is only
 * populated by a registration that opens a connection and converges DDL — inside the process that
 * also runs the conformance suite.
 *
 * The context is the only seam because a union's right side reaches {@link BuildRoot} through a
 * `PipelineStage`, whose signature carries the context and nothing else. A second seam taking the
 * resolver as an argument could therefore never reach that call, and a caller using it would get
 * its stub on one side of a union and the live registry on the other.
 */
export type OriginResolver = (schemaId: string, tableId: string) => TableOrigin;

export function RegisteredOrigin(
  schemaId: string,
  tableId: string,
): TableOrigin {
  return {
    schemaId,
    tableId,
    shape: GetTableShape(schemaId, tableId),
    index: (name) => IndexFields(name, GetIndex(schemaId, tableId, name)),
  };
}

function RootStage(
  stages: QueryStage[],
  expected: string,
  index: number,
): QueryStage {
  const found = stages[index]?.stage;
  assert(
    found === expected,
    `A table query must open with ${ROOT_STAGES.join(", ")}; stage ${index} is '${found ?? "missing"}'`,
  );
  return stages[index];
}

function RootId(stage: QueryStage): string {
  const id = stage.options?.id;
  assert(
    typeof id === "string",
    `The '${stage.stage}' stage of a table query is missing its id`,
  );
  return id;
}

/**
 * Restricts the relation to one instance, or to none at all.
 *
 * An absent id is the default instance, stored as the empty string so it compares like any
 * other. `CROSS_INSTANCE` reads every instance and so contributes no predicate — which is why
 * `NormalizeInstanceId` cannot serve here, since it rejects that sentinel outright.
 */
function InstanceFilter(
  alias: string,
  id: unknown,
  context: DecodingContext,
): string | undefined {
  if (id === CROSS_INSTANCE) {
    return undefined;
  }
  assert(
    id === undefined || id === null || typeof id === "string",
    `An instance id must be a string or CROSS_INSTANCE, received ${typeof id}`,
  );
  const value = Param(context.params, id ?? DEFAULT_INSTANCE_ID, TEXT);
  return `(${QualifiedColumn(alias, INSTANCE_COLUMN)} = ${value.sql})`;
}

/**
 * Consumes the `schema` / `instance` / `table` prefix every table query opens with, and returns
 * the base relation alongside the pipeline stages that follow it.
 */
export function BuildRoot(
  stages: QueryStage[],
  context: DecodingContext,
): RootSelection {
  const [schema, instance, table] = ROOT_STAGES.map((expected, index) =>
    RootStage(stages, expected, index),
  );
  const resolve = context.resolveOrigin ?? RegisteredOrigin;
  const schemaId = RootId(schema);
  const tableId = RootId(table);
  const alias = context.nextAlias();
  const relation = TableRelation(
    TableReference(schemaId, tableId),
    alias,
    resolve(schemaId, tableId),
  );
  const filter = InstanceFilter(alias, instance.options?.id, context);
  if (filter) {
    relation.where.push(filter);
  }
  return { relation, rest: stages.slice(ROOT_STAGES.length) };
}

function CollectInto(stages: QueryStage[], ids: Set<string>): void {
  for (const stage of stages) {
    if (stage.stage === SCHEMA_STAGE && typeof stage.options?.id === "string") {
      ids.add(stage.options.id);
    }
    for (const arg of stage.args ?? []) {
      if (arg instanceof Query) {
        CollectInto(arg.build(), ids);
      }
    }
  }
}

/**
 * Every schema the stage tree reads, including those rooted in a nested query.
 *
 * Compilation is synchronous and reads shapes that only exist once a registration has
 * converged, so the caller awaits all of these before compiling anything.
 */
export function CollectSchemaIds(stages: QueryStage[]): string[] {
  const ids = new Set<string>();
  CollectInto(stages, ids);
  return [...ids];
}
