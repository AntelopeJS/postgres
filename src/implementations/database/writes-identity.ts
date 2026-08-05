import assert from "node:assert";
import type { DecodingContext } from "./context";
import { PRIMARY_KEY_COLUMNS } from "./ddl";
import { DeclaredColumns, DocumentKeys, type TableShape } from "./fields";
import { GuardJson, OBJECT_TYPEOF, TextArray } from "./jsonb";
import {
  ID_AS_ASSERTION,
  MembersByColumn,
  type PayloadOptions,
  type PayloadSplit,
  SplitPayload,
} from "./payload";
import { AsJson } from "./readings";
import { Render, type TableOrigin } from "./relation";
import { JsonRowSource } from "./row-source";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { JsonOf, type SqlShape } from "./types";
import { EXTRA_COLUMN, ID_COLUMN, type QueryStage } from "./utils";
import {
  DecodeValue,
  FunctionBody,
  IsPlainObject,
  RecordedFunction,
  WithBoundArguments,
} from "./value";
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
 *
 * The relation is **wrapped** rather than re-projected: a row-value `IN` requires its subquery's
 * arity to match the left side exactly, and a row-mode relation renders its whole physical column
 * list, so asking that list for two columns is a hard `42601 subquery has too many columns`.
 * Selecting the key out of a subselect over the rendered relation makes the arities agree without
 * a second renderer that could drift from `Render`, and needs nothing added to the select list —
 * the row-mode column list carries `_instance` for precisely this.
 *
 * Both sides come from `PRIMARY_KEY_COLUMNS` rather than being spelled out, because a row-value
 * comparison is positional and both columns are `text`: two lists ordered differently compare
 * `_instance` against `_id`, raise nothing, and match no row.
 *
 * The relation is rendered here and nowhere else on the write path (invariant 16). `Render` binds
 * no parameters, so a compiler that calls this twice does not break the bind — it spells a
 * relation that is already several subselects deep a second time into one statement.
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
 *
 * The three travel together because they come out of one split and are spelled into opposite halves
 * of the same statement, and because the `update` path that returns them — a mapper's document
 * body — has no second chance to hand back what it left behind.
 *
 * `modified` is absent for the one `SET` list that states no column-by-column values — see
 * {@link MultiAssignment} — and that write answers the rows it matched.
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
 *
 * The driver reports rows *matched*, so setting a column to the value it already holds would
 * otherwise be counted — where the contract types every `update` and `replace` as a number of
 * modified documents. Asking the question in the statement is what makes the driver's count the
 * right one, and it costs no round trip and no parameter: the values are the fragments the `SET`
 * list already compiled, re-spelled rather than re-decoded (invariant 16).
 *
 * A row comparison rather than a conjunction of them, and `IS DISTINCT FROM` rather than `<>`,
 * because a NULL on either side is an ordinary value here: a column being cleared, or one being set
 * from NULL, is a change and `<>` would answer NULL and drop the row.
 *
 * The rows that fail it are not written at all, so an update that changes nothing also leaves no
 * dead tuples behind.
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
 * The rows the statement changes: the ones the read pipeline found, narrowed by the payload's own
 * `_id` where it supplied one, and tested for whether the assignment changes anything.
 *
 * The assertion is a predicate and never an assignment. Supplying the `_id` the row already has
 * matches it and changes nothing about the write; supplying another row's matches nothing, and the
 * write answers 0 — the count the contract already types the answer as, rather than an error. It
 * reaches here only over a selection that answers one row, which {@link RequireAddressedRow}
 * refuses everything else at.
 *
 * Parenthesised here rather than trusted to arrive that way (invariant 5): the conjuncts are joined
 * with `AND`, where anything composed would otherwise rebind across the identity target.
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
 *
 * The assertion exists for the round trip a document makes — `get(k).replace(doc)` writes the `_id`
 * it read back — and over a selection of many rows it is a mistake rather than a narrowing: one
 * document written over the rows a filter found would silently reach at most one of them. Nothing
 * is compiled here that a passing write does not compile too, so the refusal costs a boolean.
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
 *
 * The assignments arrive already compiled because the two writes that share this skeleton
 * disagree about nothing else, and compiling them first is what leaves the aliases in reading
 * order: the identity target claims one, so a `SET` list holding a derived table of its own would
 * otherwise be numbered behind the wrap it appears in front of.
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
  return SplitPayload(document, target.origin.shape, context, CHANGED);
}

/**
 * What the overflow column becomes, composed from whichever halves the payload asked for.
 *
 * The concatenation comes before the subtraction, so a payload that both writes and removes keys
 * removes them from the merged document rather than from the row's previous one — the other order
 * would resurrect a key the same payload had just removed. Absent when the payload touched no
 * undeclared key at all, which is what keeps the column out of the `SET` list entirely.
 *
 * `update`'s alone, and not `replace`'s: a statement that assigns the column outright has nothing
 * to merge into and nothing to subtract from.
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
 *
 * An `UPDATE` with an empty `SET` list is a syntax error, and answering `0` without running one
 * would need a second statement to count the rows it did not change — so an empty payload is
 * refused by name.
 *
 * The refusal is `update`'s alone. `replace({})` names every column it did not name, so it is a
 * well-formed statement that empties the row rather than one with nothing to say.
 *
 * A payload whose only key is `_id` is refused here too, and rightly: that key states which row is
 * written and never what to write into it, so `update({ _id })` still has nothing to say. It is
 * also the one payload reaching this refusal that has already decoded a value, so the reassuring
 * reading — no assignments means no keys means nothing bound — is not the reason it is safe.
 * Invariant 16 is unhurt because the throw abandons the whole compilation: the hazard is a
 * statement that runs while binding a `$n` its text never names, and no statement survives here.
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
 *
 * A column the payload is silent about is set to NULL rather than left alone, and the overflow
 * document is assigned rather than merged — that is what "the row becomes exactly this document"
 * means, and it is the whole difference from `update`. The silence a `PayloadSplit` records is
 * only the keys a caller explicitly set to `undefined`, so the columns are enumerated from the
 * declared shape instead: a payload cannot represent a key it never mentioned.
 *
 * An undeclared key the payload named as `undefined` is dropped for the same reason `insert` drops
 * one — the document it would have been removed from is the one being written, and it is not in it.
 */
function ReplacedColumns(
  split: PayloadSplit,
  shape: TableShape,
): WrittenColumn[] {
  const supplied = MembersByColumn(split);
  const written = DeclaredColumns(shape).map((column) => ({
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
function MappedShape(shape: TableShape): SqlShape {
  return Object.fromEntries(
    Object.entries(shape.fields).map(([name, spec]) => [name, spec.type]),
  );
}

/**
 * The mapper's document with everything that has a column of its own taken out of it.
 *
 * Guarded on the document being an object, and defaulted to an empty one: `jsonb - text[]` raises
 * `22023 cannot delete from scalar` and yields NULL for a NULL document, and the column is
 * `NOT NULL`, so a mapper that returned something other than a document would otherwise lose the
 * whole statement to `22023` or to `23502`. The operand spelled twice here is the derived table's
 * column rather than the mapper's body, which is the reason that table exists.
 */
function MappedExtra(mapped: Compiled, shape: TableShape): string {
  const kept = `(${mapped.sql} - ${TextArray(DocumentKeys(shape))})`;
  return `COALESCE(${GuardJson(mapped, OBJECT_TYPEOF, kept)}, ${EMPTY_EXTRA})`;
}

/**
 * A parenthesised target list, or the bare column name when there is only one of it.
 *
 * A table declaring no fields assigns nothing but the overflow column, and that one assignment is
 * spelled plainly. PostgreSQL 16 — this adapter's minimum — does accept `SET ("c") = (SELECT …)`,
 * measured against a live server, so this is the ordinary spelling of one assignment rather than a
 * workaround for a form the server refuses.
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
 *
 * `(a, b, "_extra") = (SELECT …)` is the multi-assignment form: the sub-`SELECT` is evaluated once
 * per target row and may reference that row's columns, which is what lets the mapper's body read
 * the row it is rewriting. The body is spelled exactly once, as the single column of a derived
 * table every read then projects out of — the alternative is emitting it once per column, which
 * grows the statement by the whole expression per declared field.
 *
 * The targets and the reads come from one walk of the declared fields, because they are addressed
 * differently and must still line up positionally: the assignment names `spec.column` while the
 * document is keyed by the field name, and the two differ whenever `PgIdentifier` truncated it
 * (invariant 8). Each read is the guarded jsonb projection every other layer uses, so a member
 * whose value does not fit its column is NULL rather than a `22P02` that loses the statement.
 */
function MultiAssignment(
  origin: TableOrigin,
  document: Compiled,
  context: DecodingContext,
): string {
  const alias = context.nextAlias();
  const mapped: Compiled = {
    sql: QualifiedColumn(alias, MAPPED_COLUMN),
    type: JsonOf(MappedShape(origin.shape)),
  };
  const source = new JsonRowSource(mapped);
  const declared = Object.entries(origin.shape.fields);
  const columns = [...declared.map(([, spec]) => spec.column), EXTRA_COLUMN];
  const reads = [
    ...declared.map(([name]) => source.field(name).sql),
    MappedExtra(mapped, origin.shape),
  ];
  const held = `(SELECT ${document.sql} AS ${QuoteIdentifier(MAPPED_COLUMN)}) AS ${QuoteIdentifier(alias)}`;
  return `${MappedTarget(columns)} = (SELECT ${reads.join(", ")} FROM ${held})`;
}

/**
 * The assignments a mapper makes, which take one of two shapes depending on what it returned.
 *
 * An object body is the document path exactly: its keys are static and its values are recorded
 * expressions, which is a payload the splitter already handles. Decoding it as a *value* instead
 * would build one `jsonb_build_object` and lose every column, so the binding spans the split
 * rather than a decode. Anything else is a value whose top-level keys are unknowable at compile
 * time, and becomes {@link MultiAssignment}.
 *
 * Both halves bind the lambda parameter to the row being written and not to the one that was read
 * — see {@link WriteRowSource} for why the read relation's alias cannot appear here.
 *
 * Only the object body can assert an identity, and it does so for free by being the document path:
 * an expression body is one value whose top-level keys are not known until it runs, so there is no
 * `_id` in it to read as a claim about the row.
 *
 * It is also the one path that answers the rows it *matched* rather than the rows it changed. The
 * body is a derived table inside the `SET` list, so {@link ModifiedRows} would have to spell that
 * table a second time into the `WHERE` — measured at 1.6× to 1.8× the whole statement, and a second
 * evaluation of the caller's mapper on every candidate row. Every other write path states its
 * columns one by one and pays neither.
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
  const mapper = RecordedFunction(argument);
  const changed = mapper
    ? MappedColumns(target, stage, mapper, context)
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
    ReplacedColumns(split, target.origin.shape),
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
