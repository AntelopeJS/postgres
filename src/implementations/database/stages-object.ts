import { AsJson } from "./readings";
import { type Compiled, QuoteLiteral } from "./sql";
import {
  ArrayOf,
  BOOL,
  MergeShapes,
  OPAQUE,
  type SqlType,
  TEXT,
} from "./types";
import {
  Collected,
  GuardJson,
  HeldOnce,
  OBJECT_TYPEOF,
  ORDINAL_COLUMN,
  TextArray,
  VALUE_COLUMN,
  Walk,
  WalkColumn,
} from "./jsonb";
import {
  AsSource,
  FIRST_OPERAND,
  FieldNames,
  FieldOf,
  Lift,
  LiftRaw,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";

const KEY_COLUMN = "key";
const MERGED_COLUMN = "merged";
const KEYS_FUNCTION = "jsonb_object_keys";
const ENTRIES_FUNCTION = "jsonb_each";
const CONTAINS_KEYS = "?&";
const CONTAINS = "@>";
const EMPTY_OBJECT = "'{}'::jsonb";

const ObjIndexStage: StageHandler = (state, stage, context) => ({
  current: FieldOf(AsSource(state), stage, context),
});

function Merged(left: Compiled, right: Compiled, alias: string): string {
  return HeldOnce({
    value: `${left.sql} || ${right.sql}`,
    column: MERGED_COLUMN,
    alias,
    select: (column) => column,
    guard: (column) =>
      `jsonb_typeof(${column}) = ${QuoteLiteral(OBJECT_TYPEOF)}`,
  });
}

const MergeStage = Lift((value, args, stage, context) => {
  const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  return {
    sql: Merged(AsJson(value), AsJson(other), context.nextAlias()),
    type: MergeShapes(value.type, other.type),
  };
});

interface ObjectWalk {
  func: string;
  columns: string[];
  aggregated: string;
  elem: SqlType;
}

const KEY_WALK: ObjectWalk = {
  func: KEYS_FUNCTION,
  columns: [KEY_COLUMN],
  aggregated: KEY_COLUMN,
  elem: TEXT,
};

const VALUE_WALK: ObjectWalk = {
  func: ENTRIES_FUNCTION,
  columns: [KEY_COLUMN, VALUE_COLUMN],
  aggregated: VALUE_COLUMN,
  elem: OPAQUE,
};

function Aggregation(walk: ObjectWalk, json: string, alias: string): string {
  return Walk({
    func: walk.func,
    json,
    alias,
    columns: walk.columns,
    aggregate: Collected(
      WalkColumn(alias, ORDINAL_COLUMN),
      WalkColumn(alias, walk.aggregated),
    ),
  });
}

function WalkStage(walk: ObjectWalk): StageHandler {
  return LiftRaw((value, _stage, context) => {
    const json = AsJson(value);
    const body = Aggregation(walk, json.sql, context.nextAlias());
    return {
      sql: GuardJson(json, OBJECT_TYPEOF, body),
      type: ArrayOf(walk.elem),
    };
  });
}

function IsObject(json: Compiled): string {
  return `(${json.sql} ${CONTAINS} ${EMPTY_OBJECT})`;
}

const HasStage = LiftRaw((value, stage) => {
  const json = AsJson(value);
  const test = `(${json.sql} ${CONTAINS_KEYS} ${TextArray(FieldNames(stage))})`;
  return { sql: `(${IsObject(json)} AND ${test})`, type: BOOL };
});

/**
 * Object stages.
 *
 * `obj_index` is the one stage in the whole compiler that reads the accumulator as a row rather
 * than a value, so it fits neither `Lift` nor `LiftRaw` — both materialize through `AsValue`,
 * which would turn `doc.key("price")` into a jsonb path out of a built document and lose the
 * column's index. It clears the pending timezone by returning a fresh state, exactly as those
 * adapters do.
 *
 * The other four each have one spelling that is not the obvious one:
 *
 * - `obj_merge` guards the *result* on `'object'`. `||` does not reject a non-object: it wraps
 *   and concatenates, so `{"a":1} || "x"` is `[{"a":1}, "x"]` — an array where the merged type
 *   says object, which the result decoder would then walk as the wrong shape. The guard sits on
 *   a one-column derived table so each operand is emitted once: guarding the two operands
 *   in place spells each of them twice, and merges chain, so N of them would emit 2^N copies of
 *   the whole prior expression. The value merge is one level deep, unlike ReQL's recursive
 *   `merge`; the *type* merges as `{...left, ...right}` so a date surviving a merge still
 *   decodes as a `Date`.
 * - `obj_keys` and `obj_values` walk set-returning functions, which cannot appear in an
 *   expression, so each is an aliased scalar subselect. Both order by `WITH ORDINALITY`, which
 *   pins jsonb's own stored order — the order both functions already return, so `keys()` and
 *   `values()` line up element for element — without depending on the database's collation the
 *   way a sort on the key would. Both `COALESCE` to `'[]'`, because `jsonb_agg` over zero rows
 *   is NULL rather than an empty array.
 * - `obj_has` reads its argument as a `string[]` of literal keys rather than as a value, since
 *   `?&` takes a `text[]` and not a jsonb array. It needs an object test — `?&` against a jsonb
 *   *array* tests element containment, not fields, so `["urgent"] ?& array['urgent']` is true
 *   where an array has no fields at all — but it spells that test as a **conjunction** rather
 *   than a `CASE`, and the conjunct is `@> '{}'` rather than `jsonb_typeof(…) = 'object'`. A
 *   `CASE` is one opaque expression that costs the GIN index this operator is the reason for; a
 *   conjunction keeps it, and `@> '{}'` is itself GIN-indexable, so both conjuncts land in the
 *   `Index Cond` where `jsonb_typeof` would land in a heap `Filter`. `@> '{}'` is true of an
 *   object and false of an array, a scalar and a json null, and NULL of NULL — so a non-object
 *   answers `false` rather than NULL, which is the reading a `ValueProxy<boolean>` promises. It
 *   reports a key whose value is a JSON null as present, where ReQL treats a null as missing, and
 *   an empty field list as vacuously true — of an object, and false of anything else.
 */
export const OBJECT_STAGES: StageMap = {
  obj_index: ObjIndexStage,
  obj_merge: MergeStage,
  obj_keys: WalkStage(KEY_WALK),
  obj_values: WalkStage(VALUE_WALK),
  obj_has: HasStage,
};
