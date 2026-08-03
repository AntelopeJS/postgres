import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { Cast, Widen } from "./coerce";
import type { DecodingContext } from "./context";
import {
  ApplyStages,
  type PipelineStage,
  type PipelineStageMap,
} from "./pipeline";
import {
  CurrentValue,
  type OrderTerm,
  Prepare,
  type Relation,
  type RelationFlag,
  Render,
  SetProjection,
  ValueRelation,
} from "./relation";
import { BuildRoot } from "./selection";
import type { Compiled } from "./sql";
import {
  ClampToRange,
  FIRST_OPERAND,
  INT4_MAX,
  Numeric,
  Predicate,
  RequireOperand,
  SECOND_OPERAND,
} from "./stage";
import type { SqlType } from "./types";
import { DecodeFunction, DecodeValue } from "./value";

/**
 * A `WHERE` runs before the clauses that choose rows and cannot mention an aggregate at all.
 *
 * Absorbing past a limit, an offset or a `DISTINCT` would filter the rows the relation had
 * *before* those clauses picked from them — `slice(0, 2).filter(…)` would test the whole table
 * and then take two — and absorbing past an aggregate raises
 * `42803 aggregate functions are not allowed in WHERE`. A pending projection blocks it for the
 * same reason it blocks every stage that resolves a field.
 */
const FILTER_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * An `ORDER BY` runs before the row bounds, so those and an aggregate are what block it.
 *
 * Absorbing past a limit or an offset would order the whole relation and then take a window of
 * it, which is not the window the caller sliced; absorbing past an aggregate leaves a non-grouped
 * `ORDER BY` beside one, which is `42803`. `distinct` is absent because it cannot be reached
 * from here: a dedup over a named field leaves a projection behind, which blocks, and a dedup
 * over whole rows yields a datum the contract gives no `orderBy` to.
 */
const ORDER_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "aggregated",
];

/**
 * A row bound composes with nothing that is already bounding rows, and reads no field.
 *
 * `LIMIT` and `OFFSET` are single clauses, so a second bound would silently replace the first
 * rather than compose with it, and an aggregate has already reduced the relation to one row, so a
 * bound over it belongs outside rather than beside it. `projection` is absent — a bound resolves
 * no field, which is what keeps `map(…).slice(0, 2)` a single `SELECT` — and so are `distinct`
 * and `ordered`, both of which apply before the bounds and keep their meaning under one.
 */
const BOUND_BLOCKERS: readonly RelationFlag[] = [
  "limit",
  "offset",
  "aggregated",
];

const DESCENDING = "desc";
const ONE_ROW = "1";

const LOWEST_BOUND = 0;
const HIGHEST_BOUND = INT4_MAX;

function RowBound(sql: string): string {
  return `((${sql})::bigint)`;
}

const SINGLE_ROW = RowBound(ONE_ROW);

/**
 * Bounds a row count above as well as below, and keeps an unreadable one unreadable.
 *
 * A negative `LIMIT` raises `22023` and anything outside `bigint` — `Infinity`, `NaN` and `1e20`
 * alike — raises `22003`, each losing the whole statement rather than yielding no rows. The upper
 * bound is `integer`'s rather than `bigint`'s because the `bigint` maximum is not representable
 * in `double precision` and rounds *up* past it, so clamping to it would overflow the very cast
 * it was protecting; two billion rows is past anything this adapter reads into a process.
 *
 * The NULL guard is what {@link ClampToRange} cannot do for itself: `GREATEST(NULL, 0)` is `0`,
 * which would turn a bound this adapter could not read into `LIMIT 0` and no rows at all, where
 * PostgreSQL reads a NULL bound as no bound.
 */
function ClampBound(sql: string): string {
  const clamped = ClampToRange(sql, LOWEST_BOUND, HIGHEST_BOUND);
  return `CASE WHEN ${sql} IS NOT NULL THEN ${clamped} END`;
}

/**
 * Reads a caller-supplied row bound as the `bigint` `LIMIT` and `OFFSET` take.
 *
 * A decoded number is `double precision`, whose assignment cast is not guaranteed in that
 * position, so it is cast explicitly — through {@link ClampBound}, which is what keeps the cast
 * itself total. ReQL's negative-index counting is not offered here, and clamping is a better
 * answer than guessing at it.
 */
function Bound(
  stage: QueryStage,
  index: number,
  context: DecodingContext,
): string {
  const compiled = DecodeValue(stage.args[index], context);
  const bound = RequireOperand(compiled, stage, index);
  return RowBound(ClampBound(Numeric(bound).sql));
}

/**
 * Binds the predicate to the relation's own source rather than to a materialized document, which
 * is what keeps `filter((doc) => doc.key("age").gt(25))` reading a btree-indexed column.
 *
 * The absorbed condition is parenthesised here rather than relied upon to arrive that way: the
 * entries are joined with `AND`, so one that reached this point spelling a bare disjunction would
 * silently rebind against every other conjunct (invariant 5).
 */
const FilterStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, FILTER_BLOCKERS, context);
  const body = DecodeFunction(stage.args[FIRST_OPERAND], context, [
    prepared.source,
  ]);
  const predicate = RequireOperand(body, stage, FIRST_OPERAND);
  prepared.where.push(`(${Predicate(predicate).sql})`);
  return prepared;
};

function SortName(stage: QueryStage): string {
  const name = stage.options?.index;
  assert(
    typeof name === "string",
    "The 'orderBy' stage is missing the index or field to sort on",
  );
  return name;
}

function SortFields(relation: Relation, name: string): string[] {
  return relation.origin ? relation.origin.index(name) : [name];
}

/**
 * Prepends the sort terms, so a later `orderBy` dominates an earlier one.
 *
 * The contract's semantics are successive stable sorts — sort by name, then re-sort by age
 * keeping ties in name order — which in one clause is `ORDER BY age, name`, the reverse of the
 * order the stages were written in. No null ordering is spelled: the defaults are exactly what a
 * btree index stores, and naming them turns an index range scan into a sort.
 */
const OrderByStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, ORDER_BLOCKERS, context);
  const descending = stage.options?.direction === DESCENDING;
  const terms = SortFields(prepared, SortName(stage)).map(
    (field): OrderTerm => ({
      sql: prepared.source.field(field).sql,
      descending,
    }),
  );
  prepared.orderBy.unshift(...terms);
  return prepared;
};

const SliceStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, BOUND_BLOCKERS, context);
  prepared.offset = Bound(stage, FIRST_OPERAND, context);
  if (stage.args[SECOND_OPERAND] !== undefined) {
    prepared.limit = Bound(stage, SECOND_OPERAND, context);
  }
  return prepared;
};

const NthStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, BOUND_BLOCKERS, context);
  prepared.offset = Bound(stage, FIRST_OPERAND, context);
  prepared.limit = SINGLE_ROW;
  prepared.single = true;
  return prepared;
};

const CONCATENATION = "UNION ALL";

interface UnionSide {
  relation: Relation;
  value: Compiled;
}

function Sided(relation: Relation): UnionSide {
  return { relation, value: CurrentValue(relation) };
}

/**
 * Renders one side of a union as a single-column `SELECT` of the type both sides meet at.
 *
 * `UNION ALL` matches its branches by *physical* type, and a value-mode side over a declared
 * scalar projects `text`, `double precision`, `boolean` or `timestamptz` where a row-mode side
 * projects jsonb — `42804 UNION types text and jsonb cannot be matched`, which loses the whole
 * statement. Both sides are therefore cast to the type the union itself carries, which is the one
 * spelling that cannot disagree with the other side's. Two streams of one kind keep that kind, so
 * a stream of timestamps stays `timestamptz` and still reaches the caller as a `Date`; anything
 * mixed meets as jsonb, where the logical type the union kept still drives the decoder.
 *
 * A row-mode side has its projection *set* to the materialized document rather than being
 * wrapped: that changes the select list without adding a subselect level, so each side stays one
 * `SELECT`. It is rendered exactly once, which is not an economy — every fragment already
 * appended its parameters to the shared collector, so rendering a side twice would emit each `$n`
 * twice against a bind that supplies it once.
 */
function Materialize(side: UnionSide, type: SqlType): string {
  return Render(SetProjection(side.relation, Cast(side.value, type)));
}

/**
 * Compiles the query the union concatenates, from its own `schema`/`instance`/`table` root.
 *
 * The argument is read off the stage directly rather than through `DecodeValue`, which would
 * route a query to the correlated-subquery compiler; and it compiles against the *same* context,
 * so its parameters land in the one collector the statement binds and its aliases come from the
 * one counter, which is what makes them unable to collide with the left side's.
 */
function Concatenated(stage: QueryStage, context: DecodingContext): Relation {
  const other = stage.args[FIRST_OPERAND];
  assert(
    other instanceof Query,
    "The 'union' stage takes another query to concatenate",
  );
  const root = BuildRoot(other.build(), context);
  return ApplyStages(root.relation, root.rest, context);
}

/**
 * Concatenates two streams, keeping every row of both.
 *
 * `ALL` is the whole operator: the contract asserts that a stream unioned with itself is twice as
 * long, so deduplicating would answer a question nobody asked. Each side is parenthesised because
 * either may carry its own `ORDER BY` or `LIMIT`, which is a syntax error where a set operation
 * expects a query.
 *
 * The result is an ordinary value-mode relation, which is what leaves `union(…).count()`,
 * `union(…).filter(…)` and `a.union(b).union(c)` working through the general rules with no
 * special case. Its type is the {@link Widen} of the two sides rather than their intersection —
 * each row comes from exactly one side and carries that side's keys, so a key only one side
 * declares must survive or every value under it decodes as raw json.
 */
const UnionStage: PipelineStage = (relation, stage, context) => {
  const left = Sided(relation);
  const right = Sided(Concatenated(stage, context));
  const type = Widen(left.value.type, right.value.type);
  return ValueRelation(
    `((${Materialize(left, type)}) ${CONCATENATION} (${Materialize(right, type)}))`,
    context.nextAlias(),
    type,
  );
};

/** The stages that select and order rows without reshaping what the relation yields. */
export const ROW_STAGES: PipelineStageMap = {
  filter: FilterStage,
  orderBy: OrderByStage,
  slice: SliceStage,
  nth: NthStage,
  union: UnionStage,
};
