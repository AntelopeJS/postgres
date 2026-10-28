import assert from "node:assert";

import { DecodeValue } from "./value";
import { WrittenAs } from "./readings";
import type { DecodingContext } from "./context";
import { QualifiedName } from "./identifier";
import type { ExternalRelation } from "./fields";
import { FIRST_OPERAND } from "./stage";
import { KeylessRefusal } from "./external-refusals";
import { Render, SetProjection } from "./relation";
import type { QueryStage } from "./utils";
import { ID_COLUMN } from "./utils";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import {
  type ColumnDescriptor,
  CheckFor,
  ConversionFor,
  IsReadOnly,
  ReadOnlyReason,
  WritingFor,
} from "./external-types";
import {
  type AssertedKey,
  type ExternalAssignment,
  type ExternalPayload,
  type ExternalWriteMode,
  type KeyFieldClaim,
  KeyFieldValue,
  KeyValue,
  SplitExternalPayload,
} from "./external-payload";
import {
  AsDocument,
  DescribeKind,
  WRITE_ALIAS,
  type WriteCompiler,
  type WriteStatement,
  type WriteTarget,
} from "./writes-shared";

const ALIAS = QuoteIdentifier(WRITE_ALIAS);
const SOURCE_ALIAS = QuoteIdentifier("src");
const ID = QuoteIdentifier(ID_COLUMN);
const OUTPUT = QuoteIdentifier("value");
const POSITION = QuoteIdentifier("position");
const CONFLICT_MODES = ["update", "replace"];

function ExternalOf(target: WriteTarget): ExternalRelation {
  return target.origin.shape.external as ExternalRelation;
}

/** The key a write needs: a relation without one is read-only, as the read design's cases D–F. */
function RequireKey(target: WriteTarget): ColumnDescriptor[] {
  const external = ExternalOf(target);
  if (!external.key) {
    throw KeylessRefusal(external);
  }
  return external.key;
}

function TableOf(external: ExternalRelation): string {
  return `${QualifiedName(external.schema, external.table)} AS ${ALIAS}`;
}

function WriteColumn(column: string): string {
  return QualifiedColumn(WRITE_ALIAS, column);
}

/** `_id` as a read of the written row answers it: the key's text, a JSON array for a wide key. */
function IdOfWrittenRow(key: ColumnDescriptor[]): string {
  const parts = key.map((part) => part.value(WriteColumn(part.column)));
  return parts.length === 1
    ? parts[0]
    : `(jsonb_build_array(${parts.join(", ")}))::text`;
}

/** The precision a read answers a column at, which is what "unchanged since it was read" means. */
function AsRead(sql: string, descriptor: ColumnDescriptor): string {
  return descriptor.kind.kind === "timestamp"
    ? `date_trunc('milliseconds', ${sql})`
    : sql;
}

function Written(assignment: ExternalAssignment): string {
  const writing = WritingFor(assignment.descriptor);
  assert(writing, `Field '${assignment.field}' has no writing`);
  return writing(assignment.value.sql, assignment.descriptor);
}

/**
 * One guarded assignment: the column keeps its stored value when the incoming value equals what a
 * read of it answers, so a whole row written back — data-api's edit — damages nothing a lossy
 * reading could not spell (`write-design.md` §4).
 */
function GuardedAssignment(assignment: ExternalAssignment): string {
  const descriptor = assignment.descriptor;
  if (assignment.toDefault) {
    return `${QuoteIdentifier(descriptor.column)} = DEFAULT`;
  }
  const column = WriteColumn(descriptor.column);
  const read = AsRead(descriptor.value(column), descriptor);
  const incoming = AsRead(assignment.value.sql, descriptor);
  return `${QuoteIdentifier(descriptor.column)} = (CASE WHEN ${read} IS NOT DISTINCT FROM ${incoming} THEN ${column} ELSE ${Written(assignment)} END)`;
}

/** Rows whose read differs from the incoming values: an unchanged write touches no row, and counts 0. */
function Changed(assignments: ExternalAssignment[]): string[] {
  if (assignments.length === 0) {
    return [];
  }
  const reads = assignments.map((assignment) =>
    AsRead(
      assignment.descriptor.value(WriteColumn(assignment.descriptor.column)),
      assignment.descriptor,
    ),
  );
  const incoming = assignments.map((assignment) =>
    AsRead(assignment.value.sql, assignment.descriptor),
  );
  return [`((${reads.join(", ")}) IS DISTINCT FROM (${incoming.join(", ")}))`];
}

/**
 * A key field's claim, at the precision a read of it answers — the write-back guard's rule — so the
 * value data-api's edit read back names the row it was read from, however lossy the field's kind.
 */
function KeyFieldAssertion(
  claim: KeyFieldClaim,
  context: DecodingContext,
): string {
  const descriptor = claim.descriptor;
  const read = AsRead(
    descriptor.value(WriteColumn(descriptor.column)),
    descriptor,
  );
  const incoming = AsRead(KeyFieldValue(claim, context).sql, descriptor);
  return `(${read} = ${incoming})`;
}

/** A key column the payload claims, as the row must already hold it: a key that cannot be matches nothing. */
function Assertion(asserted: AssertedKey, context: DecodingContext): string {
  const convert = ConversionFor(asserted.descriptor);
  const sql = KeyValue(asserted, context).sql;
  const value = convert ? convert(sql, "=") : sql;
  return `(${WriteColumn(asserted.descriptor.column)} = ${value})`;
}

/**
 * The rows the read pipeline selected, by their key: the relation projects its native key — the
 * bare columns, so the client's key index serves the semi-join — or, past a wrap that hid them, `_id`.
 */
function TargetedRows(target: WriteTarget, key: ColumnDescriptor[]): string {
  const relation = target.relation;
  const id = relation.source.field(ID_COLUMN);
  const projected = SetProjection(
    relation,
    id.native ? { ...id, sql: id.native.sql } : id,
  );
  const selected = `(${Render(projected)}) AS ${SOURCE_ALIAS}`;
  if (id.native && key.length > 1) {
    const row = `ROW(${key.map((part) => WriteColumn(part.column)).join(", ")})`;
    return `EXISTS (SELECT 1 FROM ${selected} WHERE ${SOURCE_ALIAS}.${OUTPUT} = ${row})`;
  }
  const written = id.native ? WriteColumn(key[0].column) : IdOfWrittenRow(key);
  return `(${written} IN (SELECT ${SOURCE_ALIAS}.${OUTPUT} FROM ${selected}))`;
}

function DocumentOf(stage: QueryStage): Record<string, unknown> {
  const argument = stage.args[FIRST_OPERAND];
  const document = AsDocument(argument);
  assert(
    document,
    `The '${stage.stage}' stage on an external relation takes a document, received ${DescribeKind(argument)}; an expression mapper is not supported on external relations in this version`,
  );
  return document;
}

/**
 * The checks a write's constant values must pass before it runs, as one `SELECT` with a ledger of
 * its own: each failure names the field, its column type and the value, which PostgreSQL's own
 * error for the same value would not.
 */
function Validation(
  checks: ValueCheck[],
  context: DecodingContext,
): WriteStatement["validation"] {
  if (checks.length === 0) {
    return undefined;
  }
  const sibling = context.sibling();
  const conditions: string[] = [];
  const failures: string[] = [];
  for (const check of checks.filter((each) => CheckFor("", each.descriptor))) {
    const value = WrittenAs(
      DecodeValue(check.raw, sibling) as Compiled,
      check.descriptor.kind,
      `Field '${check.path}'`,
    );
    const condition = CheckFor(value.sql, check.descriptor);
    if (condition) {
      conditions.push(
        `(${condition}) AS ${QuoteIdentifier(`c${conditions.length}`)}`,
      );
      failures.push(
        `Field '${check.path}' cannot hold ${JSON.stringify(check.raw)}: the column is ${check.descriptor.native}`,
      );
    }
  }
  if (conditions.length === 0) {
    return undefined;
  }
  return {
    sql: `SELECT ${conditions.join(", ")}`,
    params: sibling.params.all(),
    failures,
  };
}

interface ValueCheck {
  path: string;
  descriptor: ColumnDescriptor;
  raw: unknown;
}

function ChecksOf(
  external: ExternalRelation,
  payload: ExternalPayload,
  mode: ExternalWriteMode,
): ValueCheck[] {
  const path = `${external.schema}.${external.table}`;
  const checks: ValueCheck[] = payload.assignments
    .filter((assignment) => assignment.raw !== undefined)
    .map((assignment) => ({
      path: `${path}.${assignment.field}`,
      descriptor: assignment.descriptor,
      raw: assignment.raw,
    }));
  if (mode === "insert") {
    for (const asserted of payload.asserted.values()) {
      checks.push({
        path: `${path}.${asserted.claimedBy}`,
        descriptor: asserted.descriptor,
        raw: String(asserted.raw),
      });
    }
    for (const claim of payload.keyFields) {
      checks.push({
        path: `${path}.${claim.field}`,
        descriptor: claim.descriptor,
        raw: claim.raw,
      });
    }
  }
  return checks;
}

function ChangeStatement(
  target: WriteTarget,
  payload: ExternalPayload,
  context: DecodingContext,
  mode: ExternalWriteMode,
): WriteStatement {
  const key = RequireKey(target);
  const external = ExternalOf(target);
  const assignments = payload.assignments;
  if (assignments.length === 0) {
    return { sql: "" };
  }
  const where = [
    TargetedRows(target, key),
    ...[...payload.asserted.values()].map((asserted) =>
      Assertion(asserted, context),
    ),
    ...payload.keyFields.map((claim) => KeyFieldAssertion(claim, context)),
    ...Changed(assignments.filter((assignment) => !assignment.toDefault)),
  ];
  return {
    sql: `UPDATE ${TableOf(external)} SET ${assignments.map(GuardedAssignment).join(", ")} WHERE ${where.join(" AND ")}`,
    validation: Validation(ChecksOf(external, payload, mode), context),
  };
}

function ChangeWrite(mode: ExternalWriteMode): WriteCompiler {
  return (target, stage, context) => {
    RequireKey(target);
    const payload = SplitExternalPayload(
      DocumentOf(stage),
      target.origin.shape,
      context,
      mode,
    );
    return ChangeStatement(target, payload, context, mode);
  };
}

const ExternalDelete: WriteCompiler = (target) => {
  const key = RequireKey(target);
  return {
    sql: `DELETE FROM ${TableOf(ExternalOf(target))} WHERE ${TargetedRows(target, key)}`,
  };
};

function InsertDocuments(stage: QueryStage): Record<string, unknown>[] {
  const argument = stage.args[FIRST_OPERAND];
  const list = Array.isArray(argument) ? argument : [argument];
  return list.map((entry, position) => {
    const document = AsDocument(entry);
    assert(
      document,
      `The '${stage.stage}' stage takes documents, and the one at position ${position} is ${DescribeKind(entry)}`,
    );
    return document;
  });
}

function ConflictOf(stage: QueryStage): string | undefined {
  const conflict = stage.options?.conflict;
  if (conflict === undefined || conflict === null) {
    return undefined;
  }
  assert(
    typeof conflict === "string" && CONFLICT_MODES.includes(conflict),
    `The '${stage.stage}' stage takes a conflict mode of ${CONFLICT_MODES.join(" or ")}, received ${JSON.stringify(conflict)}`,
  );
  return conflict;
}

function ReadOnlyKey(external: ExternalRelation, asserted: AssertedKey): Error {
  return new Error(
    `Payload of '${external.schema}.${external.table}' gives key column "${asserted.descriptor.column}" a value through '${asserted.claimedBy}', but it is ${ReadOnlyReason(asserted.descriptor)}, which the database fills`,
  );
}

interface InsertedColumn {
  column: string;
  value: string;
}

function InsertedColumns(
  external: ExternalRelation,
  payload: ExternalPayload,
  context: DecodingContext,
): InsertedColumn[] {
  const keyed = [...payload.asserted.values()].map(
    (asserted): InsertedColumn => {
      if (IsReadOnly(asserted.descriptor)) {
        throw ReadOnlyKey(external, asserted);
      }
      const writing = WritingFor(asserted.descriptor);
      assert(
        writing,
        `Key column "${asserted.descriptor.column}" has no writing`,
      );
      return {
        column: asserted.descriptor.column,
        value: writing(KeyValue(asserted, context).sql, asserted.descriptor),
      };
    },
  );
  const keyFields = payload.keyFields.map((claim) => ({
    column: claim.descriptor.column,
    value: Written({
      field: claim.field,
      descriptor: claim.descriptor,
      value: KeyFieldValue(claim, context),
    }),
  }));
  const fields = payload.assignments.map((assignment) => ({
    column: assignment.descriptor.column,
    value: Written(assignment),
  }));
  return [...keyed, ...keyFields, ...fields];
}

/**
 * The conflict clause of an upsert, on the relation's own key: `update` assigns what the payload
 * names, `replace` also clears every other writable declared field. Neither touches the key or a
 * column only the database writes.
 */
function ConflictClause(
  target: WriteTarget,
  key: ColumnDescriptor[],
  columns: InsertedColumn[],
  conflict: string,
): string {
  const keyColumns = new Set(key.map((part) => part.column));
  const assigned = columns.filter((column) => !keyColumns.has(column.column));
  const sets = assigned.map(
    (column) =>
      `${QuoteIdentifier(column.column)} = EXCLUDED.${QuoteIdentifier(column.column)}`,
  );
  if (conflict === "replace") {
    const named = new Set(assigned.map((column) => column.column));
    for (const spec of Object.values(target.origin.shape.fields)) {
      const descriptor = spec.native as ColumnDescriptor;
      if (
        !named.has(descriptor.column) &&
        !keyColumns.has(descriptor.column) &&
        !IsReadOnly(descriptor)
      ) {
        const cleared = descriptor.hasDefault ? "DEFAULT" : "NULL";
        sets.push(`${QuoteIdentifier(descriptor.column)} = ${cleared}`);
      }
    }
  }
  const targetColumns = key
    .map((part) => QuoteIdentifier(part.column))
    .join(", ");
  if (sets.length === 0) {
    assert(
      !IsReadOnly(key[0]),
      `An upsert into '${ExternalOf(target).table}' names no column to update`,
    );
    sets.push(
      `${QuoteIdentifier(key[0].column)} = EXCLUDED.${QuoteIdentifier(key[0].column)}`,
    );
  }
  return ` ON CONFLICT (${targetColumns}) DO UPDATE SET ${sets.join(", ")}`;
}

function InsertRow(
  target: WriteTarget,
  key: ColumnDescriptor[],
  columns: InsertedColumn[],
  conflict: string | undefined,
): string {
  const external = ExternalOf(target);
  const values =
    columns.length === 0
      ? "DEFAULT VALUES"
      : `(${columns.map((column) => QuoteIdentifier(column.column)).join(", ")}) VALUES (${columns.map((column) => column.value).join(", ")})`;
  const upsert = conflict ? ConflictClause(target, key, columns, conflict) : "";
  return `INSERT INTO ${TableOf(external)} ${values}${upsert} RETURNING ${IdOfWrittenRow(key)} AS ${ID}`;
}

/**
 * Inserts each document as its own single-row `INSERT … RETURNING` in a CTE tagged with its
 * position, and answers the keys in that order — an order the statement states rather than one
 * PostgreSQL happens to keep (`write-design.md` §6). A column a document leaves out takes its
 * `DEFAULT`, and a key the database generates comes back as `_id`.
 */
const ExternalInsert: WriteCompiler = (target, stage, context) => {
  const key = RequireKey(target);
  const external = ExternalOf(target);
  const conflict = ConflictOf(stage);
  const documents = InsertDocuments(stage);
  if (documents.length === 0) {
    return { sql: "", ids: [] };
  }
  const checks: ValueCheck[] = [];
  const rows = documents.map((document) => {
    const payload = SplitExternalPayload(
      document,
      target.origin.shape,
      context,
      "insert",
    );
    checks.push(...ChecksOf(external, payload, "insert"));
    return InsertRow(
      target,
      key,
      InsertedColumns(external, payload, context),
      conflict,
    );
  });
  const ctes = rows.map(
    (row, position) => `${QuoteIdentifier(`i${position}`)} AS (${row})`,
  );
  const selects = rows.map(
    (_, position) =>
      `SELECT ${position} AS ${POSITION}, ${ID} FROM ${QuoteIdentifier(`i${position}`)}`,
  );
  return {
    sql: `WITH ${ctes.join(", ")} ${selects.join(" UNION ALL ")} ORDER BY ${POSITION}`,
    validation: Validation(checks, context),
    returnsIds: true,
  };
};

/** The writes of an external relation, which `writes.ts` dispatches to by the target's shape. */
export const EXTERNAL_WRITES = {
  insert: ExternalInsert,
  update: ChangeWrite("update"),
  replace: ChangeWrite("replace"),
  delete: ExternalDelete,
} satisfies Record<string, WriteCompiler>;

export function IsExternalWriteStage(
  name: string,
): name is keyof typeof EXTERNAL_WRITES {
  return Object.hasOwn(EXTERNAL_WRITES, name);
}

/** Whether a write target is a relation the adapter did not create. */
export function IsExternalTarget(target: WriteTarget): boolean {
  return target.origin.shape.external !== undefined;
}
