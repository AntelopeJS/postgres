import assert from "node:assert";
import type { DecodingContext } from "./context";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { StoredAs } from "./readings";
import {
  IndexColumns,
  Prepare,
  type Relation,
  RequireOrigin,
  SINGLE_ROW,
  WHERE_BLOCKERS,
} from "./relation";
import { type Compiled, QualifiedColumn } from "./sql";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import { IsArray } from "./types";
import { ID_COLUMN, INSTANCE_COLUMN, type QueryStage } from "./utils";
import { DecodeValue } from "./value";

const NO_KEYS = "FALSE";
const SINGLE_FIELD = 1;
const CONTAINS = "@>";

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
 * Matches a key against a column holding a *list* of values, which is what `multi` declares.
 *
 * `=` between a jsonb array and a jsonb scalar is false on every row of every dataset, so a
 * `getAll` on a declared array field matched nothing at all; `@>` is the reading the contract's own
 * multi index means, and the only one `jsonb_ops` GIN serves.
 *
 * **Deliberately unguarded** (invariant 14): a `CASE` around it is one opaque expression the
 * planner cannot push into an `Index Cond`, measured elsewhere in this compiler as a
 * `Bitmap Index Scan` becoming a `Parallel Seq Scan`. `@>` needs no guard — it is strict, and it
 * answers false rather than raising for any pair of jsonb operands.
 *
 * A key list becomes a disjunction of containments rather than one key-set operator: `?|` would
 * take the whole list at once and is `text[]`-only, so a `number[]` field would be refused at plan
 * time, and its operand is a literal array where these keys are parameters (invariant 4). The
 * planner folds the disjunction into one `BitmapOr` over the same index.
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
 * Refuses an index that keys on an array field beside others.
 *
 * A row-wise `IN` cannot spell containment for one member of a tuple, and a compound index over an
 * array field is not one the DDL builds a GIN index for either, so there is nothing for such a key
 * to reach. Refusing names the index; the alternative answers no rows on every dataset.
 */
function RequireAddressable(selection: KeySelection): void {
  assert(
    !selection.columns.some((column) => IsArray(column.type)),
    `The '${selection.indexId}' index keys on an array field beside others, which no key addresses`,
  );
}

/**
 * Matches a key list against one column, or a list of key tuples against a row of them.
 *
 * An empty list is `FALSE` rather than an empty `IN`, which is a syntax error. The single-field
 * form names the bare column so a btree index over it stays reachable, and a column declared as an
 * array takes {@link Contained} instead so its GIN index does.
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
 *
 * `_id` is unique *per instance*, so reading every instance at once turns the primary key into a key
 * matching one row per instance that stores it. The relation still called itself `single`, so a read
 * answered an arbitrary one of them — and, far worse, `get(k).delete()` targeted by identity and
 * removed **every** one, destroying other instances' rows from what the contract calls a
 * `SingleSelection`. The bound is what the write path already honours, the same way it honours a
 * `slice` before a delete.
 *
 * The order term is what makes it a *choice* rather than a coin flip: without one the row a read
 * answers and the row a delete removes need not be the same row, and two identical `get`s need not
 * agree. `_instance` is the only column that differs across the matched rows, so it is the only
 * ordering available; which instance wins is arbitrary, but it is the same one every time.
 *
 * Emitted only under `CROSS_INSTANCE`, which is why the relation carries the scope at all. Under a
 * single instance the key already names at most one row and this would buy nothing while making
 * every stage after `get` nest, since a bound blocks a `WHERE` from being absorbed.
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
 *
 * The contract types the argument as a key of the row, so it is a *field*: a compound index is
 * refused by name rather than given the row-wise comparison semantics nothing asks for. Both
 * bounds are required, since the contract has no open-ended spelling to offer instead.
 *
 * A field declared as an *array* is refused for the same reason, one layer down: a half-open range
 * has no reading over a value that is a list of values, and the jsonb ordering the comparison would
 * fall back on puts every array above every string, so both bounds answer a question nobody asked.
 * `getAll` has a containment reading to offer such a field and this stage has none, so it says so
 * rather than matching nothing on every dataset.
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
