import assert from "node:assert";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { TableReference } from "./identifier";
import type { DecodingContext } from "./context";
import { EXTRA_COLUMN, type QueryStage } from "./utils";
import type { InstanceScope, RootSelection } from "./selection";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import { type Relation, RequireOrigin, type TableOrigin } from "./relation";
import { AliasedColumns, ColumnRowSource, type RowSource } from "./row-source";
import { FIRST_OPERAND } from "./stage";
import { IsDocument } from "./guards";

/**
 * The rows a write changes, and everything it may know about them.
 *
 * `relation` is the read pipeline the write targets, rendered into an identity subselect by the
 * stages that reshape existing rows; `insert` has no rows to target and requires the relation to be
 * untouched instead. `instance` is carried straight off {@link RootSelection}, which documents why
 * the query root is the only thing that can answer it.
 */
export interface WriteTarget {
  relation: Relation;
  origin: TableOrigin;
  instance: InstanceScope;
}

/**
 * The rows a query's terminal write targets, assembled the one way.
 *
 * Both the runner and the write specs build a target, and a field added to {@link WriteTarget}
 * that only one of them populates leaves every spec green against a path production no longer
 * runs.
 */
export function WriteTargetOf(
  root: RootSelection,
  relation: Relation,
): WriteTarget {
  return {
    relation,
    origin: RequireOrigin(relation),
    instance: root.instance,
  };
}

/**
 * A statement that is not a `SELECT`, and the answer it already knows.
 *
 * `ids` is present exactly when the caller asked for keys rather than a count: `insert` generates
 * them client-side, so they are known before the statement runs and are answered in input order.
 * Empty `sql` is a write with nothing to run — an `insert` of no documents, since a `VALUES` list
 * with no tuples is a syntax error — and the answer beside it is final.
 */
export interface WriteStatement {
  sql: string;
  ids?: string[];
  /**
   * A `SELECT` of boolean checks to run before the statement, with its own parameters, and the
   * message each failing column refuses the write with. External relations only.
   */
  validation?: WriteValidation;
  /** The statement answers the written rows' `_id`s, in input order, rather than a count. */
  returnsIds?: boolean;
}

export interface WriteValidation {
  sql: string;
  params: unknown[];
  failures: string[];
}

/**
 * One terminal stage's compiler, which a write family module implements and `writes.ts` dispatches.
 *
 * The fragments every write spells the same way live here rather than beside the dispatch, so a
 * family reaches *sideways* for them and never back into the module that called it. A write is
 * terminal — the contract gives `Query` no chain methods — so no write ever contains another one,
 * and nothing a family needs can be the dispatch itself.
 */
export type WriteCompiler = (
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
) => WriteStatement;

/**
 * The alias a write statement gives the table it targets.
 *
 * It must stay disjoint from the aliases {@link DecodingContext} hands out, which is what lets the
 * identity subselect be addressed from outside it: an inner alias equal to this one shadows the
 * target, leaves every row compared against itself, and removes or rewrites the whole table with
 * no error anywhere.
 */
export const WRITE_ALIAS = "w0";
export const EMPTY_EXTRA = "'{}'::jsonb";
export const NULL_VALUE = "NULL";

/**
 * The table a write targets, under the alias the rest of its statement refers to it by.
 *
 * Every write needs that alias for its own reason — `insert`'s `DO UPDATE` names the row it
 * collided with, and the writes that target by identity qualify the key columns against it — so
 * the one spelling here is what keeps all four naming the same one.
 */
export function WriteTable(origin: TableOrigin): string {
  const table = TableReference(origin.schemaId, origin.tableId);
  return `${table} AS ${QuoteIdentifier(WRITE_ALIAS)}`;
}

/**
 * The row an assignment's own expressions read, which is the row being written.
 *
 * A mapper's lambda parameter binds here rather than to the relation the query read: that
 * relation's alias is scoped to the identity subselect and is not visible in the `SET` list at
 * all, so an expression compiled against it emits `42P01 missing FROM-clause entry`. Every `SET`
 * expression sees the row as it was *before* the statement, which is SQL's own rule and is the
 * semantics a mapper wants.
 */
export function WriteRowSource(origin: TableOrigin): RowSource {
  return new ColumnRowSource(AliasedColumns(WRITE_ALIAS), origin.model);
}

/**
 * One `SET` assignment, which is the spelling every write and the conflict clause share.
 *
 * The column arrives already resolved through `FieldSpec.column`, never as the field name it was
 * declared under, since `PgIdentifier` may have truncated the two apart.
 */
export function Assignment(column: string, value: string): string {
  return `${QuoteIdentifier(column)} = ${value}`;
}

/**
 * The targeted row's own overflow document, read back as an object rather than as NULL.
 *
 * The column is `NOT NULL`, so this defends against nothing the adapter itself wrote — but
 * concatenating a NULL jsonb yields NULL, so a row that predates the column, or one another writer
 * left empty, would have its whole overflow document blanked by the very statement adding a key to
 * it. Shared by `insert`'s merging conflict mode and by `update`, which compose it the same way.
 *
 * A constant rather than a function: this module is a leaf that no write family leads back to, so
 * a fragment composed from it at module scope cannot read it before it is assigned.
 */
export const EXISTING_EXTRA = `COALESCE(${QualifiedColumn(WRITE_ALIAS, EXTRA_COLUMN)}, ${EMPTY_EXTRA})`;

/**
 * The overflow document a merging write leaves behind, which is the row's own with keys added.
 *
 * The one owner of what "merge rather than replace" means about that column: `update` and
 * `insert`'s `update` conflict mode are the same instruction reached two ways, and a second
 * spelling would let one of them start replacing what the other merges with nothing failing.
 */
export function MergeExtra(incoming: string): string {
  return `(${EXISTING_EXTRA} || ${incoming})`;
}

/** What a caller passed where a write wanted a document, for the error that refuses it. */
export function DescribeKind(value: unknown): string {
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/**
 * The documents one `insert` stage writes, whether the caller passed one or a batch.
 * An array is the batch and never a document, which is the reading every other write shares. The
 * refusal names the position, since a batch is where a caller would look for the entry.
 */
export function InsertedDocuments(
  stage: QueryStage,
): Record<string, unknown>[] {
  const argument: unknown = stage.args[FIRST_OPERAND];
  const list = Array.isArray(argument) ? argument : [argument];
  return list.map((entry, position) => {
    assert(
      IsDocument(entry),
      `The '${stage.stage}' stage takes documents, and the one at position ${position} is ${DescribeKind(entry)}`,
    );
    return entry;
  });
}

/**
 * The instance fragment the query root bound, for the writes that need one named.
 *
 * `CROSS_INSTANCE` is the *absence* of an instance predicate, which a write that states a whole
 * row has no answer for. `insert` has no instance to write its rows into, and defaulting to the
 * unnamed one would write rows the caller cannot see from the query that created them; `replace`
 * states every column of rows it did not name one by one, which the mongodb backend refuses
 * across instances for the same reason and which parity keeps refused here. The stages that change
 * named columns or remove rows the read already found are allowed under it and call neither this
 * nor {@link RefuseCrossInstance}.
 */
export function RequireInstance(
  target: WriteTarget,
  stage: QueryStage,
): Compiled {
  const scope = target.instance;
  assert(
    scope !== CROSS_INSTANCE,
    `The '${stage.stage}' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one`,
  );
  return scope;
}

/** Refuses a write that names every instance at once without needing the one it names. */
export function RefuseCrossInstance(
  target: WriteTarget,
  stage: QueryStage,
): void {
  RequireInstance(target, stage);
}
