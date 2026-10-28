import assert from "node:assert";
import { StagedObject } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { TEXT } from "./types";
import { IndexFields } from "./ddl";
import { IsPlainObject } from "./value";
import type { ExternalRelation } from "./fields";
import { QualifiedName, TableReference } from "./identifier";
import type { DecodingContext } from "./context";
import { type Compiled, Param, QualifiedColumn } from "./sql";
import { type Relation, type TableOrigin, TableRelation } from "./relation";
import { GetCrossInstanceScanNotice, GetIndex, GetTableModel } from "./schema";
import { DEFAULT_INSTANCE_ID, INSTANCE_COLUMN, type QueryStage } from "./utils";
import { IsObject, IsString } from "./guards";

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
 * parameter for it would leave this one bound and unreferenced.
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
  /** The relation the query reads, when the adapter did not create it. */
  external?: ExternalRelation;
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
    model: GetTableModel(schemaId, tableId),
    index: (name) => IndexFields(name, GetIndex(schemaId, tableId, name)),
    crossInstanceScan: GetCrossInstanceScanNotice(schemaId, tableId),
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
    IsString(id),
    `The '${stage.stage}' stage of a table query is missing its id`,
  );
  return id;
}

/**
 * The instance a query reads, bound once for the predicate and for any write that follows.
 * An absent id is the empty string; `CROSS_INSTANCE` binds nothing and contributes no predicate.
 */
function RootInstanceScope(
  id: unknown,
  context: DecodingContext,
): InstanceScope {
  if (id === CROSS_INSTANCE) {
    return CROSS_INSTANCE;
  }
  assert(
    id === undefined || id === null || IsString(id),
    `An instance id must be a string or CROSS_INSTANCE, received ${typeof id}`,
  );
  return Param(context.params, id ?? DEFAULT_INSTANCE_ID, TEXT);
}

/** Restricts the relation to one instance, parenthesised as every `where` entry is. */
function InstancePredicate(alias: string, value: Compiled): string {
  return `(${QualifiedColumn(alias, INSTANCE_COLUMN)} = ${value.sql})`;
}

function NamedInstance(external: ExternalRelation, id: unknown): Error {
  return new Error(
    `${QualifiedName(external.schema, external.table)} is an external relation and has no instances, so instance '${String(id)}' names nothing: read it through the default instance`,
  );
}

/**
 * The scope of a read over a relation the adapter did not create, which has no instances: the
 * default instance and `CROSS_INSTANCE` both read every row, and a named instance is refused rather
 * than answered with rows nobody scoped to it.
 */
function RefuseNamedInstance(external: ExternalRelation, id: unknown): void {
  const unscoped: readonly unknown[] = [
    undefined,
    null,
    CROSS_INSTANCE,
    DEFAULT_INSTANCE_ID,
  ];
  if (!unscoped.includes(id)) {
    throw NamedInstance(external, id);
  }
}

/** An external relation's root: its own names, verbatim, and no instance to filter on. */
function ExternalRoot(
  origin: TableOrigin,
  external: ExternalRelation,
  instanceId: unknown,
  context: DecodingContext,
): Relation {
  RefuseNamedInstance(external, instanceId);
  const from = QualifiedName(external.schema, external.table);
  return TableRelation(from, context.nextAlias(), origin);
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
  const origin = resolve(schemaId, tableId);
  const rest = stages.slice(ROOT_STAGES.length);
  const external = origin.model.external;
  if (external) {
    const relation = ExternalRoot(
      origin,
      external,
      instance.options?.id,
      context,
    );
    return { relation, rest, instance: CROSS_INSTANCE, external };
  }
  const alias = context.nextAlias();
  const relation = TableRelation(
    TableReference(schemaId, tableId),
    alias,
    origin,
  );
  const scope = RootInstanceScope(instance.options?.id, context);
  relation.crossInstance = scope === CROSS_INSTANCE;
  if (scope !== CROSS_INSTANCE) {
    relation.where.push(InstancePredicate(alias, scope));
  }
  return { relation, rest, instance: scope };
}

/** The ids found so far, beside the objects already walked, carried through one collection. */
interface SchemaWalk {
  ids: Set<string>;
  visited: WeakSet<object>;
}

/**
 * Walks a stage argument, which is caller data and may be any shape a document may be.
 * Plain objects reach every recorded lambda body; the visited set is for a caller's cyclic object.
 */
function CollectValue(value: unknown, walk: SchemaWalk): void {
  if (!IsObject(value) || walk.visited.has(value)) {
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
    if (stage.stage === SCHEMA_STAGE && IsString(stage.options?.id)) {
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
