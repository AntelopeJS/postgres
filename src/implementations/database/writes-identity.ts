import assert from "node:assert";
import type { DecodingContext } from "./context";
import { PRIMARY_KEY_COLUMNS } from "./ddl";
import { DeclaredColumns, DocumentKeys, type TableShape } from "./fields";
import {
  MembersByColumn,
  type PayloadOptions,
  type PayloadSplit,
  SplitPayload,
} from "./payload";
import { Render, type TableOrigin } from "./relation";
import { JsonRowSource } from "./row-source";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import {
  AsJson,
  FIRST_OPERAND,
  GuardJson,
  OBJECT_TYPEOF,
  TextArray,
} from "./stage";
import { JsonOf, type SqlShape } from "./types";
import { EXTRA_COLUMN, type QueryStage } from "./utils";
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

/** Neither `update` nor `replace` is keyed by its payload: a write cannot change the identity it targeted. */
const CHANGED: PayloadOptions = { acceptsId: false };

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

/**
 * The statement `update` and `replace` compile to, given the `SET` list each built for itself.
 *
 * The assignments arrive already compiled because the two writes that share this skeleton
 * disagree about nothing else, and compiling them first is what leaves the aliases in reading
 * order: the identity target claims one, so a `SET` list holding a derived table of its own would
 * otherwise be numbered behind the wrap it appears in front of.
 */
function UpdateStatement(
  target: WriteTarget,
  assignments: string,
  context: DecodingContext,
): WriteStatement {
  const where = IdentityTarget(target, context);
  return {
    sql: `UPDATE ${WriteTable(target.origin)} SET ${assignments} WHERE ${where}`,
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
 * refused by name. Nothing has been decoded at that point either: a payload with no assignments is
 * a payload with no keys, so the refusal cannot leave a parameter bound and unreferenced.
 *
 * The refusal is `update`'s alone. `replace({})` names every column it did not name, so it is a
 * well-formed statement that empties the row rather than one with nothing to say.
 */
function SetList(split: PayloadSplit, stage: QueryStage): string {
  const assignments = split.members.map((member) =>
    Assignment(member.column, member.value.sql),
  );
  for (const column of split.cleared) {
    assignments.push(Assignment(column, NULL_VALUE));
  }
  const extra = UpdatedExtra(split);
  if (extra) {
    assignments.push(Assignment(EXTRA_COLUMN, extra));
  }
  assert(
    assignments.length > 0,
    `The '${stage.stage}' stage was given a payload with nothing to write: name a field to set, or set one to undefined to remove it`,
  );
  return assignments.join(", ");
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
function ReplacedAssignments(split: PayloadSplit, shape: TableShape): string {
  const written = MembersByColumn(split);
  const assignments = DeclaredColumns(shape).map((column) =>
    Assignment(column, written.get(column)?.sql ?? NULL_VALUE),
  );
  assignments.push(Assignment(EXTRA_COLUMN, split.extra?.sql ?? EMPTY_EXTRA));
  return assignments.join(", ");
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
 */
function MappedAssignments(
  target: WriteTarget,
  stage: QueryStage,
  mapper: QueryStage,
  context: DecodingContext,
): string {
  const body = FunctionBody(mapper);
  const bindings = [WriteRowSource(target.origin)];
  if (IsPlainObject(body)) {
    return SetList(
      WithBoundArguments(mapper, context, bindings, () =>
        ChangedPayload(body, target, context),
      ),
      stage,
    );
  }
  const document = WithBoundArguments(mapper, context, bindings, () =>
    DecodeValue(body, context),
  );
  assert(
    document,
    `The '${stage.stage}' stage was given a mapper that returned nothing: return the document the rows become`,
  );
  return MultiAssignment(target.origin, AsJson(document), context);
}

/**
 * Changes the rows the read pipeline selected, one column per key the payload named.
 *
 * Allowed under `CROSS_INSTANCE` for the reason the `SET` list makes structural: `_instance` is
 * never assigned — the payload splitter refuses it outright — so every row keeps the instance it
 * was read from and a cross-instance update means each instance's own rows, not a migration
 * between them. The answer is the count the driver reports, which is rows *matched* rather than
 * rows changed: setting a column to the value it already held is counted here and is not counted
 * by the mongodb backend.
 */
export const UpdateWrite: WriteCompiler = (target, stage, context) => {
  const argument = stage.args[FIRST_OPERAND];
  const mapper = RecordedFunction(argument);
  const assignments = mapper
    ? MappedAssignments(target, stage, mapper, context)
    : SetList(
        ChangedPayload(ChangedDocument(stage, argument), target, context),
        stage,
      );
  return UpdateStatement(target, assignments, context);
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
  return UpdateStatement(
    target,
    ReplacedAssignments(split, target.origin.shape),
    context,
  );
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
