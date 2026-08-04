import assert from "node:assert";
import { randomUUID } from "node:crypto";
import type { DecodingContext } from "./context";
import { PRIMARY_KEY_LIST } from "./ddl";
import { DeclaredColumns, type TableShape } from "./fields";
import {
  ID_AS_KEY,
  MembersByColumn,
  type PayloadOptions,
  SplitPayload,
} from "./payload";
import type { TableOrigin } from "./relation";
import { type Compiled, Param, QuoteIdentifier } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { TEXT } from "./types";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
  type QueryStage,
} from "./utils";
import {
  AsDocument,
  Assignment,
  DescribeKind,
  EMPTY_EXTRA,
  MergeExtra,
  NULL_VALUE,
  RequireInstance,
  type WriteCompiler,
  WriteTable,
} from "./writes-shared";

const EXCLUDED_ROW = "EXCLUDED";
const INSERTED: PayloadOptions = { id: ID_AS_KEY };

function Excluded(column: string): string {
  return `${EXCLUDED_ROW}.${QuoteIdentifier(column)}`;
}

/**
 * The physical column order an insert names, given whatever the caller has for each part.
 *
 * The column list and every tuple beneath it are built from different material — names in one,
 * compiled values in the other — and have to agree *positionally*, so a second spelling of the
 * order is how a tuple writes each value into the column beside the one it meant: same arity, no
 * error, every row wrong.
 */
function PhysicalOrder<T>(key: T, instance: T, declared: T[], extra: T): T[] {
  return [key, instance, ...declared, extra];
}

/**
 * What a conflicting row does with the tuple that collided with it.
 *
 * The two modes differ in **which columns the statement names**, not in what the `DO UPDATE` does
 * with them: a uniform assignment over every declared column would null every field an upsert's
 * payload omitted, which is the opposite of what `update` means. `update` therefore names only the
 * keys the batch supplied and concatenates the overflow document, while `replace` names every
 * declared column so an omitted one is set to NULL and replaces the overflow document outright.
 */
interface ConflictMode {
  everyColumn: boolean;
  extra: string;
}

const EXCLUDED_EXTRA = Excluded(EXTRA_COLUMN);

const CONFLICT_MODES: Record<string, ConflictMode> = {
  update: { everyColumn: false, extra: MergeExtra(EXCLUDED_EXTRA) },
  replace: { everyColumn: true, extra: EXCLUDED_EXTRA },
};

function ConflictModeOf(stage: QueryStage): ConflictMode | undefined {
  const conflict = stage.options?.conflict;
  if (conflict === undefined || conflict === null) {
    return undefined;
  }
  assert(
    typeof conflict === "string" && Object.hasOwn(CONFLICT_MODES, conflict),
    `The '${stage.stage}' stage takes a conflict mode of ${Object.keys(CONFLICT_MODES).join(" or ")}, received ${JSON.stringify(conflict)}`,
  );
  return CONFLICT_MODES[conflict];
}

/**
 * The documents one `insert` stage writes, whether the caller passed one or a batch.
 *
 * An array is the batch and never a document, which is the reading {@link AsDocument} shares with
 * every other write: a nested array would otherwise be stored as an overflow document keyed by its
 * indices rather than refused.
 */
function Documents(stage: QueryStage): Record<string, unknown>[] {
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

interface InsertRow {
  id: string;
  key: Compiled;
  values: Map<string, Compiled>;
  extra?: Compiled;
}

/**
 * The key a document supplies, if it supplies one at all.
 *
 * It has to be read off the raw payload as well as split out of it, because the id is part of the
 * answer `insert` returns and a compiled parameter cannot be read back.
 */
function SuppliedId(document: Record<string, unknown>): string | undefined {
  const supplied = Object.hasOwn(document, ID_COLUMN)
    ? document[ID_COLUMN]
    : undefined;
  if (supplied === undefined) {
    return undefined;
  }
  assert(
    typeof supplied === "string",
    `An inserted document's '${ID_COLUMN}' must be a string, received ${typeof supplied}`,
  );
  return supplied;
}

/**
 * One document, compiled into the pieces a tuple is assembled from.
 *
 * The key comes from whichever of the two sources produced it: a supplied one is already a member
 * of the split and is used as it was compiled there, and a generated one is bound here — taking
 * both would name the column twice in one tuple. It is bound before the payload is split so the
 * `$n` a tuple binds run in the order the tuple reads.
 */
function InsertRowOf(
  document: Record<string, unknown>,
  shape: TableShape,
  context: DecodingContext,
): InsertRow {
  const supplied = SuppliedId(document);
  const id = supplied ?? randomUUID();
  const generated =
    supplied === undefined ? Param(context.params, id, TEXT) : undefined;
  const split = SplitPayload(document, shape, context, INSERTED);
  const values = MembersByColumn(split);
  const key = generated ?? values.get(ID_COLUMN);
  assert(
    key,
    `An inserted row is keyed by the '${ID_COLUMN}' its payload supplied or by the one generated for it`,
  );
  values.delete(ID_COLUMN);
  return { id, key, values, extra: split.extra };
}

/**
 * The declared columns some row of the batch writes, in the order the table declares them.
 *
 * Derived from the compiled rows rather than from the raw payloads, so every column that bound a
 * `$n` is one the tuples name: a value decoded into a column the list then omitted would leave the
 * statement binding a parameter no text references (invariant 16). Reading the payloads a second
 * time would decide the same question with a second copy of `payload.ts`'s routing rules.
 */
function BatchColumns(shape: TableShape, rows: InsertRow[]): string[] {
  return DeclaredColumns(shape).filter((column) =>
    rows.some((row) => row.values.has(column)),
  );
}

/**
 * One document's tuple, naming the batch's columns rather than its own.
 *
 * Every tuple of a `VALUES` list has to be the same width, so a document that did not supply a
 * column another one did writes NULL there. The overflow document is `NOT NULL`, so a row with no
 * undeclared keys writes an empty object rather than nothing.
 */
function RowTuple(row: InsertRow, columns: string[], instance: string): string {
  const declared = columns.map(
    (column) => row.values.get(column)?.sql ?? NULL_VALUE,
  );
  const values = PhysicalOrder(
    row.key.sql,
    instance,
    declared,
    row.extra?.sql ?? EMPTY_EXTRA,
  );
  return `(${values.join(", ")})`;
}

function ConflictClause(
  columns: string[],
  mode: ConflictMode | undefined,
): string {
  if (!mode) {
    return "";
  }
  const assignments = columns.map((column) =>
    Assignment(column, Excluded(column)),
  );
  assignments.push(Assignment(EXTRA_COLUMN, mode.extra));
  return ` ON CONFLICT (${PRIMARY_KEY_LIST}) DO UPDATE SET ${assignments.join(", ")}`;
}

/**
 * The insert target, aliased so a `DO UPDATE` clause can name the row it collided with.
 *
 * Without an alias that reference has to be the bare table name, which is the unqualified half of
 * a schema-qualified target and reads as a different object.
 */
function InsertInto(origin: TableOrigin, columns: string[]): string {
  const named = PhysicalOrder(
    ID_COLUMN,
    INSTANCE_COLUMN,
    columns,
    EXTRA_COLUMN,
  ).map((column) => QuoteIdentifier(column));
  return `INSERT INTO ${WriteTable(origin)} (${named.join(", ")})`;
}

/**
 * Writes new rows, and answers the keys it generated for them in input order.
 *
 * The one write that never reads the relation, which is why the seam refuses it behind any stage
 * that shaped one and why it is the only write that has to reference the instance fragment the
 * query root already bound rather than binding its own.
 */
export const InsertWrite: WriteCompiler = (target, stage, context) => {
  const instance = RequireInstance(target, stage);
  const documents = Documents(stage);
  if (documents.length === 0) {
    return { sql: "", ids: [] };
  }
  const shape = target.origin.shape;
  const mode = ConflictModeOf(stage);
  const rows = documents.map((document) =>
    InsertRowOf(document, shape, context),
  );
  const columns = mode?.everyColumn
    ? DeclaredColumns(shape)
    : BatchColumns(shape, rows);
  const tuples = rows.map((row) => RowTuple(row, columns, instance.sql));
  const sql = `${InsertInto(target.origin, columns)} VALUES ${tuples.join(", ")}${ConflictClause(columns, mode)}`;
  return { sql, ids: rows.map((row) => row.id) };
};
