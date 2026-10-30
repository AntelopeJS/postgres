import assert from "node:assert";

import { AsJson } from "./readings";
import { FIRST_OPERAND } from "./stage";
import { PRIMARY_KEY_COLUMNS } from "./ddl";
import { JsonRowSource } from "./row-source";
import { JsonOf, type KeyTypes } from "./types";
import type { DecodingContext } from "./context";
import { type TableOrigin } from "./relation";
import { Render } from "./render";
import { GuardJson, OBJECT_TYPEOF, TextArray } from "./jsonb";
import { EXTRA_COLUMN, ID_COLUMN, type QueryStage } from "./utils";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import { DeclaredColumns, DocumentKeys, type TableModel } from "./fields";
import {
  DecodeValue,
  FunctionBody,
  IsPlainObject,
  IsRecordedFunction,
  WithBoundArguments,
} from "./value";
import {
  ID_AS_ASSERTION,
  MembersByColumn,
  type PayloadOptions,
  type PayloadSplit,
  SplitPayload,
} from "./payload";
import {
  AsDocument,
  Assignment,
  DescribeKind,
  EMPTY_EXTRA,
  EXISTING_EXTRA,
  MergeExtra,
  NULL_VALUE,
  RefuseCrossInstance,
  WRITE_ALIAS,
  type WriteCompiler,
  WriteRowSource,
  type WriteStatement,
  WriteTable,
  type WriteTarget,
} from "./writes-shared";

/** Neither `update` nor `replace` is keyed by its payload: an `_id` it names states a target. */
const CHANGED: PayloadOptions = { id: ID_AS_ASSERTION };

/** The one-column derived table a mapper's document is read back out of, column and all. */
const MAPPED_COLUMN = "doc";

/** The identity columns of one aliased row, in the order the primary key declares them. */
function KeyTuple(alias: string): string {
  return PRIMARY_KEY_COLUMNS.map((column) =>
    QualifiedColumn(alias, column),
  ).join(", ");
}

/**
 * The `WHERE` predicate addressing exactly the rows the read pipeline found, by their identity.
 * Wrapped so the arities agree, and keyed off `PRIMARY_KEY_COLUMNS` since the comparison is positional.
 */
function IdentityTarget(target: WriteTarget, context: DecodingContext): string {
  const source = context.nextAlias();
  const wrapped = `(${Render(target.relation)}) AS ${QuoteIdentifier(source)}`;
  return `(${KeyTuple(WRITE_ALIAS)}) IN (SELECT ${KeyTuple(source)} FROM ${wrapped})`;
}

/** One column a write assigns, beside the value it assigns to it, both already compiled. */
interface WrittenColumn {
  column: string;
  value: string;
}

/**
 * One payload's `SET` list, and the row identity that payload asserted if it named one.
 * `modified` is absent for the one `SET` list stating no column-by-column values.
 */
interface ChangedColumns {
  assignments: string;
  modified?: string;
  identity?: Compiled;
}

/** A `SET` list, from the columns and values that are also what the statement counts by. */
function Assignments(written: WrittenColumn[]): string {
  return written.map((one) => Assignment(one.column, one.value)).join(", ");
}

/**
 * The rows this write would actually change, which is the count the contract says it answers.
 * `IS DISTINCT FROM` over a row value, since a NULL on either side is an ordinary value here.
 */
function ModifiedRows(written: WrittenColumn[]): string {
  const columns = written.map((one) =>
    QualifiedColumn(WRITE_ALIAS, one.column),
  );
  const values = written.map((one) => one.value);
  return `((${columns.join(", ")}) IS DISTINCT FROM (${values.join(", ")}))`;
}

/** One write's `SET` list and the two predicates the columns it names imply. */
function ChangedFrom(
  written: WrittenColumn[],
  identity: Compiled | undefined,
): ChangedColumns {
  return {
    assignments: Assignments(written),
    modified: ModifiedRows(written),
    identity,
  };
}

/**
 * The rows the statement changes: those the pipeline found, narrowed by any asserted `_id`.
 * The assertion is a predicate and never an assignment, so a foreign key answers 0 rather than raising.
 */
function TargetedRows(
  target: WriteTarget,
  changed: ChangedColumns,
  context: DecodingContext,
): string {
  const predicates = [IdentityTarget(target, context)];
  if (changed.identity) {
    const key = QualifiedColumn(WRITE_ALIAS, ID_COLUMN);
    predicates.push(`(${key} = ${changed.identity.sql})`);
  }
  if (changed.modified) {
    predicates.push(changed.modified);
  }
  return predicates.join(" AND ");
}

/**
 * Refuses a payload that asserts a key over a selection the write did not address by one.
 * Over many rows the key is a mistake rather than a narrowing, and would reach at most one of them.
 */
function RequireAddressedRow(
  target: WriteTarget,
  stage: QueryStage,
  identity: Compiled | undefined,
): void {
  assert(
    target.relation.single || !identity,
    `The '${stage.stage}' stage was given a payload naming '${ID_COLUMN}' over a selection of many rows: address the row with get(${ID_COLUMN}) first, or leave '${ID_COLUMN}' out of the payload`,
  );
}

/**
 * The statement `update` and `replace` compile to, given the columns each built for itself.
 * The assignments arrive already compiled, which is what leaves the aliases in reading order.
 */
function UpdateStatement(
  target: WriteTarget,
  stage: QueryStage,
  changed: ChangedColumns,
  context: DecodingContext,
): WriteStatement {
  RequireAddressedRow(target, stage, changed.identity);
  const where = TargetedRows(target, changed, context);
  const table = WriteTable(target.origin);
  return {
    sql: `UPDATE ${table} SET ${changed.assignments} WHERE ${where}`,
  };
}

function ChangedDocument(
  stage: QueryStage,
  argument: unknown,
): Record<string, unknown> {
  const document = AsDocument(argument);
  assert(
    document,
    `The '${stage.stage}' stage takes a document, received ${DescribeKind(argument)}`,
  );
  return document;
}

function ChangedPayload(
  document: Record<string, unknown>,
  target: WriteTarget,
  context: DecodingContext,
): PayloadSplit {
  return SplitPayload(document, target.origin.model, context, CHANGED);
}

/**
 * What the overflow column becomes, composed from whichever halves the payload asked for.
 * The concatenation precedes the subtraction, so a removed key is not resurrected by the same payload.
 */
function UpdatedExtra(split: PayloadSplit): string | undefined {
  if (!split.extra && split.removed.length === 0) {
    return undefined;
  }
  const merged = split.extra ? MergeExtra(split.extra.sql) : EXISTING_EXTRA;
  if (split.removed.length === 0) {
    return merged;
  }
  return `(${merged} - ${TextArray(split.removed)})`;
}

/**
 * The assignments one `update` payload makes, and the refusal of a payload that makes none.
 * An empty `SET` list is a syntax error, so an empty payload — `_id` alone included — is refused.
 */
function UpdatedColumns(
  split: PayloadSplit,
  stage: QueryStage,
): WrittenColumn[] {
  const written = split.members.map((member) => ({
    column: member.column,
    value: member.value.sql,
  }));
  for (const column of split.cleared) {
    written.push({ column, value: NULL_VALUE });
  }
  const extra = UpdatedExtra(split);
  if (extra) {
    written.push({ column: EXTRA_COLUMN, value: extra });
  }
  assert(
    written.length > 0,
    `The '${stage.stage}' stage was given a payload with nothing to write: name a field to set, or set one to undefined to remove it`,
  );
  return written;
}

/** One `update` payload as the statement takes it: what it sets, and what it says it targets. */
function ChangedColumnsOf(
  split: PayloadSplit,
  stage: QueryStage,
): ChangedColumns {
  return ChangedFrom(UpdatedColumns(split, stage), split.identity);
}

/**
 * The assignments one `replace` payload makes, which are every column the table has.
 * A column the payload is silent about is set to NULL, and the overflow document is assigned outright.
 */
function ReplacedColumns(
  split: PayloadSplit,
  model: TableModel,
): WrittenColumn[] {
  const supplied = MembersByColumn(split);
  const written = DeclaredColumns(model).map((column) => ({
    column,
    value: supplied.get(column)?.sql ?? NULL_VALUE,
  }));
  written.push({
    column: EXTRA_COLUMN,
    value: split.extra?.sql ?? EMPTY_EXTRA,
  });
  return written;
}

/** The types a mapper's document carries, keyed the way the document is: by field name. */
function MappedKeyTypes(model: TableModel): KeyTypes {
  return Object.fromEntries(
    Object.entries(model.fields).map(([name, spec]) => [name, spec.type]),
  );
}

/**
 * The mapper's document with everything that has a column of its own taken out of it.
 * Guarded on the document being an object and defaulted to an empty one, since the column is `NOT NULL`.
 */
function MappedExtra(mapped: Compiled, model: TableModel): string {
  const kept = `(${mapped.sql} - ${TextArray(DocumentKeys(model))})`;
  return `COALESCE(${GuardJson(mapped, OBJECT_TYPEOF, kept)}, ${EMPTY_EXTRA})`;
}

/**
 * A parenthesised target list, or the bare column name when there is only one of it.
 * The single-column form is the ordinary spelling rather than a workaround; the server takes both.
 */
function MappedTarget(columns: string[]): string {
  const named = columns.map((column) => QuoteIdentifier(column));
  if (named.length === 1) {
    return named[0];
  }
  return `(${named.join(", ")})`;
}

/**
 * Assigns every column at once from one evaluation of a mapper whose keys are not statically known.
 * The body is spelled once as a derived table, and targets and reads come from one positional walk.
 */
function MultiAssignment(
  origin: TableOrigin,
  document: Compiled,
  context: DecodingContext,
): string {
  const alias = context.nextAlias();
  const mapped: Compiled = {
    sql: QualifiedColumn(alias, MAPPED_COLUMN),
    type: JsonOf(MappedKeyTypes(origin.model)),
  };
  const source = new JsonRowSource(mapped);
  const declared = Object.entries(origin.model.fields);
  const columns = [...declared.map(([, spec]) => spec.column), EXTRA_COLUMN];
  const reads = [
    ...declared.map(([name]) => source.field(name).sql),
    MappedExtra(mapped, origin.model),
  ];
  const held = `(SELECT ${document.sql} AS ${QuoteIdentifier(MAPPED_COLUMN)}) AS ${QuoteIdentifier(alias)}`;
  return `${MappedTarget(columns)} = (SELECT ${reads.join(", ")} FROM ${held})`;
}

/**
 * The assignments a mapper makes: an object body is the document path, anything else multi-assigns.
 * Only the object body can assert an identity, and only the expression body answers rows *matched*.
 */
function MappedColumns(
  target: WriteTarget,
  stage: QueryStage,
  mapper: QueryStage,
  context: DecodingContext,
): ChangedColumns {
  const body = FunctionBody(mapper);
  const bindings = [WriteRowSource(target.origin)];
  if (IsPlainObject(body)) {
    const split = WithBoundArguments(mapper, context, bindings, () =>
      ChangedPayload(body, target, context),
    );
    return ChangedColumnsOf(split, stage);
  }
  const document = WithBoundArguments(mapper, context, bindings, () =>
    DecodeValue(body, context),
  );
  assert(
    document,
    `The '${stage.stage}' stage was given a mapper that returned nothing: return the document the rows become`,
  );
  return {
    assignments: MultiAssignment(target.origin, AsJson(document), context),
  };
}

/**
 * Changes the rows the read pipeline selected, one column per key the payload named.
 *
 * Allowed under `CROSS_INSTANCE` for the reason the `SET` list makes structural: `_instance` is
 * never assigned — the payload splitter refuses it outright — so every row keeps the instance it
 * was read from and a cross-instance update means each instance's own rows, not a migration
 * between them. The answer is the count the driver reports, which {@link ModifiedRows} makes the
 * number of rows *changed* — the number the contract types this as — for every payload that states
 * its columns one by one. A mapper's expression body is the exception, and {@link MappedColumns}
 * states what it costs.
 */
export const UpdateWrite: WriteCompiler = (target, stage, context) => {
  const argument = stage.args[FIRST_OPERAND];
  const changed = IsRecordedFunction(argument)
    ? MappedColumns(target, stage, argument, context)
    : ChangedColumnsOf(
        ChangedPayload(ChangedDocument(stage, argument), target, context),
        stage,
      );
  return UpdateStatement(target, stage, changed, context);
};

/**
 * States the rows the read pipeline selected in full: every declared column and the overflow one.
 *
 * Every row the pipeline found is replaced, not merely the first — the target is the whole read
 * relation, where the mongodb backend's `findOneAndReplace` stops at one. Refused under
 * `CROSS_INSTANCE` by name, unlike `update`, which changes only the columns a caller wrote.
 */
export const ReplaceWrite: WriteCompiler = (target, stage, context) => {
  RefuseCrossInstance(target, stage);
  const document = ChangedDocument(stage, stage.args[FIRST_OPERAND]);
  const split = ChangedPayload(document, target, context);
  const changed = ChangedFrom(
    ReplacedColumns(split, target.origin.model),
    split.identity,
  );
  return UpdateStatement(target, stage, changed, context);
};

/**
 * Removes the rows the read pipeline selected, ordering and row bounds included.
 *
 * Allowed under `CROSS_INSTANCE` where `insert` is refused: a delete writes no column, so it has
 * no instance to choose and the rows it found are simply the rows it goes on to remove. Tightening
 * that would break the contract's own cleanup, which drops every instance's rows through
 * `table.delete()` in four `after` hooks. The answer is the count the driver reports, since a
 * delete knows nothing in advance.
 */
export const DeleteWrite: WriteCompiler = (target, _stage, context) => {
  const where = IdentityTarget(target, context);
  return { sql: `DELETE FROM ${WriteTable(target.origin)} WHERE ${where}` };
};
