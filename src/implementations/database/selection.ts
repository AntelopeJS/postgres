import assert from "node:assert";
import { StagedObject } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";
import type { DecodingContext } from "./context";
import { IndexFields } from "./ddl";
import { TableReference } from "./identifier";
import { type Relation, type TableOrigin, TableRelation } from "./relation";
import { GetIndex, GetTableShape } from "./schema";
import { type Compiled, Param, QualifiedColumn } from "./sql";
import { TEXT } from "./types";
import { DEFAULT_INSTANCE_ID, INSTANCE_COLUMN, type QueryStage } from "./utils";
import { IsPlainObject } from "./value";

export const SCHEMA_STAGE = "schema";
const INSTANCE_STAGE = "instance";
const TABLE_STAGE = "table";

const ROOT_STAGES: readonly string[] = [
  SCHEMA_STAGE,
  INSTANCE_STAGE,
  TABLE_STAGE,
];

/**
 * How a query is scoped to an instance: the fragment its predicate bound, or every instance at once.
 *
 * One value rather than a resolved id beside an optional fragment, because the two are the same
 * fact read twice — a named instance always bound a parameter and `CROSS_INSTANCE` never does — and
 * a pair admits two states nothing can produce. The fragment is the one the predicate itself used:
 * a write that does not render the relation still needs the instance, and binding a second
 * parameter for it would leave this one bound and unreferenced (invariant 16).
 *
 * A relation records only the *absence* of an instance predicate, so it cannot tell a
 * cross-instance query from a table nobody filtered; this is what the writes read instead.
 */
export type InstanceScope = typeof CROSS_INSTANCE | Compiled;

/** The base relation of a table query, the stages still to fold over it, and the instance it reads. */
export interface RootSelection {
  relation: Relation;
  rest: QueryStage[];
  instance: InstanceScope;
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
 * The instance a query reads, bound once for the predicate and for any write that follows.
 *
 * An absent id is the default instance, stored as the empty string so it compares like any
 * other. `CROSS_INSTANCE` reads every instance, so it binds nothing and contributes no predicate —
 * which is also why `NormalizeInstanceId` cannot serve here, since it rejects that sentinel
 * outright.
 */
function RootInstanceScope(
  id: unknown,
  context: DecodingContext,
): InstanceScope {
  if (id === CROSS_INSTANCE) {
    return CROSS_INSTANCE;
  }
  assert(
    id === undefined || id === null || typeof id === "string",
    `An instance id must be a string or CROSS_INSTANCE, received ${typeof id}`,
  );
  return Param(context.params, id ?? DEFAULT_INSTANCE_ID, TEXT);
}

/** Restricts the relation to one instance, parenthesised as every `where` entry is (invariant 5). */
function InstancePredicate(alias: string, value: Compiled): string {
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
  const scope = RootInstanceScope(instance.options?.id, context);
  relation.crossInstance = scope === CROSS_INSTANCE;
  if (scope !== CROSS_INSTANCE) {
    relation.where.push(InstancePredicate(alias, scope));
  }
  return {
    relation,
    rest: stages.slice(ROOT_STAGES.length),
    instance: scope,
  };
}

/** The ids found so far, beside the objects already walked, carried through one collection. */
interface SchemaWalk {
  ids: Set<string>;
  visited: WeakSet<object>;
}

/**
 * Walks a stage argument, which is caller data and may be any shape a document may be.
 *
 * A recorded lambda is the plain object `{ stage: "func", args: [[id], body] }`, so walking plain
 * objects reaches every body a caller wrote and no case for a recorded function is needed.
 * {@link IsPlainObject} rather than a bare object test, so a `Date` is read as the value it is
 * instead of a record of whatever keys it happens to carry; and the visited set, because a caller's
 * own object may be cyclic where builder output never is.
 */
function CollectValue(value: unknown, walk: SchemaWalk): void {
  if (typeof value !== "object" || value === null || walk.visited.has(value)) {
    return;
  }
  walk.visited.add(value);
  if (value instanceof StagedObject) {
    CollectInto(value.build(), walk);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      CollectValue(item, walk);
    }
    return;
  }
  if (IsPlainObject(value)) {
    for (const item of Object.values(value)) {
      CollectValue(item, walk);
    }
  }
}

function CollectInto(stages: QueryStage[], walk: SchemaWalk): void {
  for (const stage of stages) {
    if (stage.stage === SCHEMA_STAGE && typeof stage.options?.id === "string") {
      walk.ids.add(stage.options.id);
    }
    for (const arg of stage.args ?? []) {
      CollectValue(arg, walk);
    }
  }
}

/**
 * Every schema the stage tree reads, including those rooted in a nested query.
 *
 * Compilation is synchronous and reads shapes that only exist once a registration has
 * converged, so the caller awaits all of these before compiling anything. A nested root reaches
 * this through a general walk of every stage argument rather than through a test for a `Query`,
 * because a `Query` used as a value is one of the shapes a lambda body or a document may hold.
 */
export function CollectSchemaIds(stages: QueryStage[]): string[] {
  const walk: SchemaWalk = { ids: new Set<string>(), visited: new WeakSet() };
  CollectInto(stages, walk);
  return [...walk.ids];
}
