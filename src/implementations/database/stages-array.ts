import type { QueryStage } from "@antelopejs/interface-database/common";

import { Cast } from "./coerce";
import type { Compiled } from "./sql";
import { DecodeFunction } from "./value";
import type { DecodingContext } from "./context";
import { ArrayOf, BOOL, FLOAT, OPAQUE, type SqlType } from "./types";
import {
  ARRAY_TYPEOF,
  Collected,
  GuardJson,
  ORDINAL_COLUMN,
  VALUE_COLUMN,
  Walk,
  WalkColumn,
} from "./jsonb";
import {
  AsFloat,
  AsJson,
  ClampToRange,
  INT4_MAX,
  INT4_MIN,
  Numeric,
  ORDERED_KINDS,
  Predicate,
} from "./readings";
import {
  BuildStages,
  FIRST_OPERAND,
  Lift,
  LiftRaw,
  RequireOperand,
  SECOND_OPERAND,
  type StageHandler,
  type StageMap,
} from "./stage";

const ELEMENTS_FUNCTION = "jsonb_array_elements";
const LENGTH_FUNCTION = "jsonb_array_length";
const BUILD_ARRAY = "jsonb_build_array";
const CONTAINS = "@>";
const AT_INDEX = "->";
const NO_ELEMENTS = "0";
const EMPTY_SUM = "0";
const AFTER_START = ">";
const BEFORE_END = "<=";

/** Where the array begins: a bound below it counts from the end, and cannot reach past it. */
const ARRAY_ORIGIN = "0";

function ElementType(type: SqlType): SqlType {
  return type.kind === "array" ? type.elem : OPAQUE;
}

function Element(alias: string, type: SqlType): Compiled {
  return Cast({ sql: WalkColumn(alias, VALUE_COLUMN), type: OPAQUE }, type);
}

function Ordinal(alias: string): string {
  return WalkColumn(alias, ORDINAL_COLUMN);
}

function WalkElements(
  json: string,
  alias: string,
  aggregate: string,
  predicate?: string,
): string {
  return Walk({
    func: ELEMENTS_FUNCTION,
    json,
    alias,
    columns: [VALUE_COLUMN],
    aggregate,
    predicate,
  });
}

type Measure = (length: string) => Compiled;

const MEASURES: Record<string, Measure> = {
  arr_count: (length) => AsFloat(length),
  arr_empty: (length) => ({ sql: `(${length} = ${NO_ELEMENTS})`, type: BOOL }),
};

function MeasureStage(measure: Measure): StageHandler {
  return LiftRaw((value) => {
    const json = AsJson(value);
    const measured = measure(`${LENGTH_FUNCTION}(${json.sql})`);
    return {
      sql: GuardJson(json, ARRAY_TYPEOF, measured.sql),
      type: measured.type,
    };
  });
}

function Position(key: Compiled): string {
  return `(${ClampToRange(Numeric(key).sql, INT4_MIN, INT4_MAX)}::int)`;
}

const IndexStage = Lift((value, args, stage) => {
  const elem = ElementType(value.type);
  const json = AsJson(value);
  const key = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  const item = `(${json.sql} ${AT_INDEX} ${Position(key)})`;
  const element = Cast({ sql: item, type: OPAQUE }, elem);
  return {
    sql: GuardJson(json, ARRAY_TYPEOF, element.sql),
    type: element.type,
  };
});

const IncludesStage = Lift((value, args, stage) => {
  const json = AsJson(value);
  const other = AsJson(
    RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
  );
  const test = `(${json.sql} ${CONTAINS} ${BUILD_ARRAY}(${other.sql}))`;
  return { sql: test, type: BOOL };
});

/**
 * One slice bound as an ordinal, counted back from the array's own length when it is negative.
 * `trunc` is what makes a fractional bound agree with `Array.prototype.slice`.
 */
function FromEnd(json: string, bound: string): string {
  const truncated = `trunc(${bound})`;
  const counted = `GREATEST(${LENGTH_FUNCTION}(${json}) + ${truncated}, ${ARRAY_ORIGIN})`;
  return `(CASE WHEN ${truncated} < ${ARRAY_ORIGIN} THEN ${counted} ELSE ${truncated} END)`;
}

function Bounds(
  json: string,
  alias: string,
  start: Compiled,
  end: Compiled | undefined,
): string {
  const low = FromEnd(json, Numeric(start).sql);
  const bounds = [`${Ordinal(alias)} ${AFTER_START} ${low}`];
  if (end) {
    const high = FromEnd(json, Numeric(end).sql);
    bounds.push(`${Ordinal(alias)} ${BEFORE_END} ${high}`);
  }
  return `(${bounds.join(" AND ")})`;
}

const SliceStage = Lift((value, args, stage, context) => {
  const elem = ElementType(value.type);
  const json = AsJson(value);
  const start = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  const alias = context.nextAlias();
  const collected = Collected(Ordinal(alias), WalkColumn(alias, VALUE_COLUMN));
  const bounds = Bounds(json.sql, alias, start, args[SECOND_OPERAND]);
  return {
    sql: GuardJson(
      json,
      ARRAY_TYPEOF,
      WalkElements(json.sql, alias, collected, bounds),
    ),
    type: ArrayOf(elem),
  };
});

interface Lambda {
  alias: string;
  body: Compiled;
}

function BindElement(
  value: Compiled,
  stage: QueryStage,
  context: DecodingContext,
): Lambda {
  const func = stage.args[FIRST_OPERAND];
  if (!func || !Array.isArray(func.args?.[FIRST_OPERAND])) {
    throw new Error(`Stage '${stage.stage}' requires a callback`);
  }
  const alias = context.nextAlias();
  const element = Element(alias, ElementType(value.type));
  const body = DecodeFunction(func, context, [element]);
  return { alias, body: RequireOperand(body, stage, FIRST_OPERAND) };
}

const MapStage = LiftRaw((value, stage, context) => {
  const lambda = BindElement(value, stage, context);
  const json = AsJson(value);
  const collected = Collected(Ordinal(lambda.alias), AsJson(lambda.body).sql);
  return {
    sql: GuardJson(
      json,
      ARRAY_TYPEOF,
      WalkElements(json.sql, lambda.alias, collected),
    ),
    type: ArrayOf(lambda.body.type),
  };
});

const FilterStage = LiftRaw((value, stage, context) => {
  const elem = ElementType(value.type);
  const lambda = BindElement(value, stage, context);
  const json = AsJson(value);
  const collected = Collected(
    Ordinal(lambda.alias),
    WalkColumn(lambda.alias, VALUE_COLUMN),
  );
  const kept = Predicate(lambda.body).sql;
  return {
    sql: GuardJson(
      json,
      ARRAY_TYPEOF,
      WalkElements(json.sql, lambda.alias, collected, kept),
    ),
    type: ArrayOf(elem),
  };
});

type ElementReading = (elem: SqlType) => SqlType;

interface Reducer {
  func: string;
  reading: ElementReading;
  empty?: string;
}

const AS_NUMBER: ElementReading = () => FLOAT;
const AS_COMPARABLE: ElementReading = (elem) =>
  ORDERED_KINDS[elem.kind] ?? FLOAT;

const REDUCERS: Record<string, Reducer> = {
  arr_sum: { func: "sum", reading: AS_NUMBER, empty: EMPTY_SUM },
  arr_avg: { func: "avg", reading: AS_NUMBER },
  arr_min: { func: "min", reading: AS_COMPARABLE },
  arr_max: { func: "max", reading: AS_COMPARABLE },
};

function Reduced(reducer: Reducer, target: string): string {
  const reduced = `${reducer.func}(${target})`;
  return reducer.empty ? `COALESCE(${reduced}, ${reducer.empty})` : reduced;
}

function ReducerStage(reducer: Reducer): StageHandler {
  return LiftRaw((value, _stage, context) => {
    const alias = context.nextAlias();
    const element = Element(alias, reducer.reading(ElementType(value.type)));
    const json = AsJson(value);
    const reduced = Reduced(reducer, element.sql);
    return {
      sql: GuardJson(
        json,
        ARRAY_TYPEOF,
        WalkElements(json.sql, alias, reduced),
      ),
      type: element.type,
    };
  });
}

/**
 * Array stages.
 *
 * Every one of them except `arr_includes` guards its operand on `jsonb_typeof(…) = 'array'`,
 * because `jsonb_array_length` and `jsonb_array_elements` both raise on anything else and `->`
 * reads a jsonb *scalar* as its own first element. `jsonb_typeof(NULL)` is NULL, so the same
 * `CASE` also propagates a NULL operand and there is no second branch to get wrong: a real empty
 * array aggregates to `[]`, a non-array yields NULL, and NULL stays NULL.
 *
 * The seven stages that walk elements are aliased scalar subselects, since a set-returning function
 * cannot appear in an expression. Every alias comes from `context.nextAlias()`, so two walks in
 * one expression — or one nested inside another — never collide. All of them take `WITH
 * ORDINALITY` and every aggregation that builds an array orders by it: `jsonb_agg` preserves
 * input order in practice but does not promise it, and a plan change reordering an array is
 * silent and data-dependent. `jsonb_agg` over zero rows is NULL rather than `[]`, hence the
 * `COALESCE` on each.
 *
 * The rest of the family is where the spellings are not the obvious ones:
 *
 * - `arr_index` reads the element at the *declared* element type, so indexing a `string[]` yields
 *   `text` rather than jsonb and compares against a text parameter without a further projection.
 *   Its subscript is clamped to the int4 range: `->` takes an `integer` and `trunc(3e9)::int`
 *   raises `22003`, which would lose the whole statement. jsonb's `->` is 0-based and counts a
 *   negative subscript from the end; the contract documents neither, since it says only
 *   *Position in the array*, so both are properties of the SQL rather than promises to a caller.
 * - `arr_includes` is `@>` rather than an `EXISTS` over the elements, and it is the one stage in
 *   the family with no guard, because the guard is what a planner sees: a `CASE` is opaque and
 *   costs the GIN index a `multi` declaration exists to buy — measured as a `Bitmap Index Scan`
 *   bare against a `Parallel Seq Scan` guarded, over 200 000 rows. `@>` needs no guard: it is
 *   strict, so a NULL operand stays NULL, and it answers `false` rather than raising for a
 *   number, a string or an object on either side. It is recursive for a container element, so
 *   `[[1,2]].includes([1])` is true where the contract says false.
 * - `arr_slice` translates 0-based end-exclusive bounds onto 1-based ordinality, which is why the
 *   lower bound is a strict `>` and the upper an inclusive `<=`. Either bound counts from the end
 *   when it is negative — see {@link FromEnd} — which is what `slice(-3)` means in ReQL, in
 *   JavaScript and in both sibling backends. Comparing an untranslated `-3` against a 1-based
 *   ordinal is true of every element, so the whole array came back.
 * - `arr_map` and `arr_filter` bind the element as a `Compiled` argument rather than a row, at
 *   the declared element type, so `map((tag) => tag.upcase())` over a `string[]` reaches `upper`
 *   without a jsonb round trip. They read their callback raw: it is a recorded lambda, not a
 *   value, and decoding it through `DecodeValue` would bind a parameter no fragment references.
 *   `map` carries the body's type into the result so `map(…).count()` keeps working; `filter`
 *   keeps the element type, and a NULL predicate drops the element.
 * - `arr_sum`, `arr_avg`, `arr_min` and `arr_max` read each element through the guarded jsonb
 *   projection, so an element of the wrong type is NULL and the aggregate skips it. Sum of an
 *   empty array is 0 and average of one stays NULL, as the contract has it. PostgreSQL has no
 *   `min(jsonb)`, so the comparison type comes from the declared element type when it is `text`,
 *   `float` or `timestamp` and defaults to `float`, which is the reading the contract documents.
 */
export const ARRAY_STAGES: StageMap = {
  arr_index: IndexStage,
  arr_includes: IncludesStage,
  arr_slice: SliceStage,
  arr_map: MapStage,
  arr_filter: FilterStage,
  ...BuildStages(MEASURES, MeasureStage),
  ...BuildStages(REDUCERS, ReducerStage),
};
