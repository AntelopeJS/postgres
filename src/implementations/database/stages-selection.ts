import assert from "node:assert";
import type { DecodingContext } from "./context";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import {
  IndexColumns,
  Prepare,
  type Relation,
  RequireOrigin,
  WHERE_BLOCKERS,
} from "./relation";
import type { Compiled } from "./sql";
import {
  FIRST_OPERAND,
  RequireOperand,
  SECOND_OPERAND,
  StoredAs,
} from "./stage";
import { ID_COLUMN, type QueryStage } from "./utils";
import { DecodeValue } from "./value";

const NO_KEYS = "FALSE";
const SINGLE_FIELD = 1;

/**
 * One selection stage mid-compilation.
 *
 * Every one of these is needed at the bottom of the key walk — the columns to type each element,
 * the stage and the index name to say which key was wrong, the context to bind its parameter — so
 * they travel as one value rather than as three passthrough arguments on every helper.
 */
interface KeySelection {
  relation: Relation;
  columns: Compiled[];
  indexId: string | undefined;
  stage: QueryStage;
  context: DecodingContext;
}

/**
 * Opens a selection stage the way `filter` opens, and resolves the columns its keys address.
 *
 * Requiring the origin is what makes a reshaped relation refuse the stage by name rather than
 * compare a key against a materialized document.
 *
 * An absent index name addresses `_id` directly instead of going through the resolver, which would
 * honour a schema that happened to declare an index called `_id` and send the lookup at whatever
 * fields that index keys on.
 */
function Selected(
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
  indexId: string | undefined,
): KeySelection {
  const prepared = Prepare(relation, WHERE_BLOCKERS, context);
  RequireOrigin(prepared);
  const columns =
    indexId === undefined
      ? [prepared.source.field(ID_COLUMN)]
      : IndexColumns(prepared, indexId);
  return { relation: prepared, columns, indexId, stage, context };
}

function IndexOption(stage: QueryStage): string | undefined {
  const name = stage.options?.index;
  if (name === undefined || name === null) {
    return undefined;
  }
  assert(
    typeof name === "string",
    `The '${stage.stage}' stage names its index with a string, received ${typeof name}`,
  );
  return name;
}

/**
 * Reads one caller-supplied key as the type of the column it addresses.
 *
 * Only `undefined` is an absent operand. A `null` key is a value and reads as one — a json null
 * against an overflow key, and this adapter's uniform "no answer" NULL against a typed column,
 * which matches no row. It is deliberately not an open bound: the contract has no spelling for
 * one, and reading it as one would answer a different question from the one a caller who meant a
 * stored null asked.
 */
function KeyValue(
  selection: KeySelection,
  key: unknown,
  column: Compiled,
  index: number,
): string {
  const value = RequireOperand(
    DecodeValue(key, selection.context),
    selection.stage,
    index,
  );
  return StoredAs(value, column.type).sql;
}

/** An array at the top level is always a list of keys, which is what the varargs form means. */
function KeyList(argument: unknown): unknown[] {
  return Array.isArray(argument) ? argument : [argument];
}

function KeyArity(key: unknown): string {
  return Array.isArray(key) ? `${key.length} values` : `a ${typeof key}`;
}

/**
 * One key, taken whole against a single-field index and element-wise against a compound one.
 *
 * A hole inside a tuple is named by the index and the position it is missing from, rather than
 * through {@link RequireOperand}: the whole tuple is one stage argument, so an operand position
 * would report the argument that *was* supplied.
 */
function KeyTuple(selection: KeySelection, key: unknown): string {
  const columns = selection.columns;
  if (columns.length === SINGLE_FIELD) {
    return KeyValue(selection, key, columns[0], FIRST_OPERAND);
  }
  assert(
    Array.isArray(key) && key.length === columns.length,
    `The '${selection.indexId}' index takes a key of ${columns.length} values, received ${KeyArity(key)}`,
  );
  const parts = key.map((part, position) => {
    assert(
      part !== undefined,
      `The '${selection.indexId}' index takes a value for every field, and has none at position ${position}`,
    );
    return KeyValue(selection, part, columns[position], FIRST_OPERAND);
  });
  return `(${parts.join(", ")})`;
}

/**
 * Matches a key list against one column, or a list of key tuples against a row of them.
 *
 * An empty list is `FALSE` rather than an empty `IN`, which is a syntax error. The single-field
 * form names the bare column so a btree index over it stays reachable.
 */
function KeySet(selection: KeySelection, keys: unknown[]): string {
  if (keys.length === 0) {
    return NO_KEYS;
  }
  const tuples = keys.map((key) => KeyTuple(selection, key));
  const columns = selection.columns;
  const addressed =
    columns.length === SINGLE_FIELD
      ? columns[0].sql
      : `(${columns.map((column) => column.sql).join(", ")})`;
  return `${addressed} IN (${tuples.join(", ")})`;
}

/**
 * The one relation that answers `undefined` rather than `null` for a row that is not there.
 *
 * No index name is read off the stage: `get` addresses the primary key by definition, and
 * resolving an option nobody is meant to pass would silently answer a different question.
 */
const GetStage: PipelineStage = (relation, stage, context) => {
  const selection = Selected(relation, stage, context, undefined);
  const prepared = selection.relation;
  const column = selection.columns[0];
  const key = KeyValue(
    selection,
    stage.args[FIRST_OPERAND],
    column,
    FIRST_OPERAND,
  );
  prepared.where.push(`(${column.sql} = ${key})`);
  prepared.single = true;
  prepared.absent = undefined;
  return prepared;
};

/** Naming no index selects on the primary key, which is the contract's own default. */
const GetAllStage: PipelineStage = (relation, stage, context) => {
  const selection = Selected(relation, stage, context, IndexOption(stage));
  const keys = KeyList(stage.args[FIRST_OPERAND]);
  selection.relation.where.push(`(${KeySet(selection, keys)})`);
  return selection.relation;
};

/**
 * Restricts the relation to a half-open range over one field, low inclusive and high exclusive.
 *
 * The contract types the argument as a key of the row, so it is a *field*: a compound index is
 * refused by name rather than given the row-wise comparison semantics nothing asks for. Both
 * bounds are required, since the contract has no open-ended spelling to offer instead.
 */
const BetweenStage: PipelineStage = (relation, stage, context) => {
  const name = IndexOption(stage);
  assert(name !== undefined, "The 'between' stage is missing its field name");
  const selection = Selected(relation, stage, context, name);
  const columns = selection.columns;
  assert(
    columns.length === SINGLE_FIELD,
    `The 'between' stage ranges over one field, but '${name}' names ${columns.length}`,
  );
  const column = columns[0];
  const low = KeyValue(
    selection,
    stage.args[FIRST_OPERAND],
    column,
    FIRST_OPERAND,
  );
  const high = KeyValue(
    selection,
    stage.args[SECOND_OPERAND],
    column,
    SECOND_OPERAND,
  );
  selection.relation.where.push(`(${column.sql} >= ${low})`);
  selection.relation.where.push(`(${column.sql} < ${high})`);
  return selection.relation;
};

/** The stages that pick rows by key, each absorbing one predicate exactly as `filter` does. */
export const SELECTION_STAGES: PipelineStageMap = {
  get: GetStage,
  getAll: GetAllStage,
  between: BetweenStage,
};
