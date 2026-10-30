import assert from "node:assert";

import { IsArray } from "./types";
import { StoredAs } from "./readings";
import { DecodeValue } from "./value";
import type { DecodingContext } from "./context";
import { type Compiled, QualifiedColumn } from "./sql";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { ID_COLUMN, INSTANCE_COLUMN, type QueryStage } from "./utils";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import { KeylessRefusal } from "./external-refusals";
import {
  type Relation,
  type TableOrigin,
  RequireOrigin,
  ScanColumns,
} from "./relation";
import { Prepare, SINGLE_ROW, WHERE_BLOCKERS } from "./render";
import { IsString } from "./guards";

const NO_KEYS = "FALSE";
const EQUALITY = "=";
const AT_LEAST = ">=";
const BELOW = "<";
const SINGLE_FIELD = 1;
const CONTAINS = "@>";

/**
 * One selection stage mid-compilation: the columns, the stage and index name, and the context.
 * All are needed at the bottom of the key walk, so they travel as one value rather than as three.
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
 * An absent index name addresses `_id` directly rather than through the resolver.
 */
function Selected(
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
  indexId: string | undefined,
): KeySelection {
  const prepared = Prepare(relation, WHERE_BLOCKERS, context);
  RequireKey(RequireOrigin(prepared), indexId);
  const columns =
    indexId === undefined
      ? [prepared.source.field(ID_COLUMN)]
      : ScanColumns(prepared, indexId);
  return {
    relation: prepared,
    columns: columns.map(Addressed),
    indexId,
    stage,
    context,
  };
}

/** Refuses reading by `_id` a relation that has no key to alias, rather than matching nothing. */
function RequireKey(origin: TableOrigin, indexId: string | undefined): void {
  const external = origin.model.external;
  const byKey = indexId === undefined || indexId === ID_COLUMN;
  if (external && !external.key && byKey) {
    throw KeylessRefusal(external);
  }
}

/**
 * A key column as the stage compares it: the bare column of an external relation, so its index
 * serves the match, keeping the native operand that converts each key into its type.
 */
function Addressed(column: Compiled): Compiled {
  return column.native ? { ...column, sql: column.native.sql } : column;
}

function IndexOption(stage: QueryStage): string | undefined {
  const name: unknown = stage.options?.index;
  if (name === undefined || name === null) {
    return undefined;
  }
  assert(
    IsString(name),
    `The '${stage.stage}' stage names its index with a string, received ${typeof name}`,
  );
  return name;
}

/**
 * Reads one caller-supplied key as the type of the column it addresses.
 * Only `undefined` is an absent operand; a `null` key is a value, and deliberately not an open bound.
 */
function KeyValue(
  selection: KeySelection,
  key: unknown,
  column: Compiled,
  index: number,
  operator = EQUALITY,
): string {
  const value = RequireOperand(
    DecodeValue(key, selection.context),
    selection.stage,
    index,
  );
  const stored = StoredAs(value, column.type);
  return column.native ? column.native.bind(stored.sql, operator) : stored.sql;
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
 * A hole inside a tuple is named by the index and the position it is missing from.
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
 * Matches a key against a column holding a *list* of values, which is what `multi` declares.
 * Deliberately unguarded and spelled as a disjunction, so the GIN index stays reachable.
 */
function Contained(selection: KeySelection, keys: unknown[]): string {
  const column = selection.columns[0];
  const tests = keys.map(
    (key) =>
      `(${column.sql} ${CONTAINS} ${KeyValue(selection, key, column, FIRST_OPERAND)})`,
  );
  return tests.join(" OR ");
}

/**
 * Refuses an index that keys on an array field beside others, naming the index.
 * A row-wise `IN` cannot spell containment for one member, and the DDL builds no GIN index for it.
 */
function RequireAddressable(selection: KeySelection): void {
  assert(
    !selection.columns.some((column) => IsArray(column.type)),
    `The '${selection.indexId}' index keys on an array field beside others, which no key addresses`,
  );
}

/**
 * Matches a key list against one column, or a list of key tuples against a row of them.
 * An empty list is `FALSE`; a column declared as an array takes {@link Contained} instead.
 */
function KeySet(selection: KeySelection, keys: unknown[]): string {
  if (keys.length === 0) {
    return NO_KEYS;
  }
  const columns = selection.columns;
  if (columns.length === SINGLE_FIELD && IsArray(columns[0].type)) {
    return Contained(selection, keys);
  }
  RequireAddressable(selection);
  const tuples = keys.map((key) => KeyTuple(selection, key));
  const addressed =
    columns.length === SINGLE_FIELD
      ? columns[0].sql
      : `(${columns.map((column) => column.sql).join(", ")})`;
  return `${addressed} IN (${tuples.join(", ")})`;
}

/**
 * Makes a key that names many rows name one of them, which only `CROSS_INSTANCE` can produce.
 * Ordered by `_instance` so a read and a delete agree on which row, and emitted only under it.
 */
function BoundToOneInstance(relation: Relation): void {
  if (!relation.crossInstance) {
    return;
  }
  relation.orderBy.push({
    sql: QualifiedColumn(relation.alias, INSTANCE_COLUMN),
    descending: false,
  });
  relation.limit = SINGLE_ROW;
}

/**
 * The one relation that answers `undefined` rather than `null` for a row that is not there.
 * No index name is read off the stage: `get` addresses the primary key by definition.
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
  BoundToOneInstance(prepared);
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
 * A compound index and an array field are both refused by name, having no reading to offer.
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
  assert(
    !IsArray(column.type),
    `The 'between' stage ranges over one value, but '${name}' holds a list`,
  );
  const low = KeyValue(
    selection,
    stage.args[FIRST_OPERAND],
    column,
    FIRST_OPERAND,
    AT_LEAST,
  );
  const high = KeyValue(
    selection,
    stage.args[SECOND_OPERAND],
    column,
    SECOND_OPERAND,
    BELOW,
  );
  selection.relation.where.push(`(${column.sql} ${AT_LEAST} ${low})`);
  selection.relation.where.push(`(${column.sql} ${BELOW} ${high})`);
  return selection.relation;
};

/**
 * The stages that pick rows by key, each absorbing one predicate exactly as `filter` does.
 *
 * A field declared as an array is the one place they part company: `getAll` matches it by
 * containment, which is the reading a `multi` index is created for, and `between` refuses it.
 */
export const SELECTION_STAGES: PipelineStageMap = {
  get: GetStage,
  getAll: GetAllStage,
  between: BetweenStage,
};
