import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { AsFloat, Numeric, ORDERED_KINDS } from "./readings";
import {
  AbsorbOrder,
  CurrentValue,
  Prepare,
  type Relation,
  type RelationFlag,
  SetProjection,
} from "./relation";
import type { Compiled } from "./sql";

/**
 * An aggregate reads whichever rows the relation has already selected.
 *
 * A limit, an offset, a `DISTINCT` and an earlier aggregate each decide *which* rows there are,
 * so absorbing past one would aggregate a different set than the caller wrote; a pending
 * projection blocks it for the same reason it blocks every stage that resolves a field.
 * `ordered` is deliberately absent — an ordering cannot change an aggregate, so the terms are
 * cleared rather than wrapped around.
 */
const AGGREGATE_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * Everything that blocks an aggregate, plus an existing ordering.
 *
 * The extra entry is the one that is not about choosing rows: `SELECT DISTINCT <value> … ORDER BY
 * <other>` raises `42P10 for SELECT DISTINCT, ORDER BY expressions must appear in select list`.
 * Wrapping moves the sort inside, where it is legal and inert, so a distinct discards the
 * ordering ahead of it.
 */
const DISTINCT_BLOCKERS: readonly RelationFlag[] = [
  ...AGGREGATE_BLOCKERS,
  "ordered",
];

const COUNT = "count";
const SUM = "sum";
const AVERAGE = "avg";
const MINIMUM = "min";
const MAXIMUM = "max";
const DISTINCT = "distinct";

const ALL_ROWS = "*";
const EMPTY_SUM = "0";
const DEDUPED = "DISTINCT ";

/**
 * An aggregate over an operand, optionally over its *distinct* values.
 *
 * The dedup channel is what a group's sub-stream spends a pending `distinct` through, and it is a
 * channel rather than a string the caller assembles so that {@link Applied} stays the one owner of
 * an aggregate call's `DISTINCT ` prefix (invariant 17). `min` and `max` take it harmlessly — a
 * dedup cannot move an extremum — which is what lets the fold pass it uniformly rather than per
 * aggregate.
 */
export type Aggregation = (operand: Compiled, distinct?: boolean) => Compiled;

/**
 * The field an aggregate reads, or nothing for the whole-value reading each of them also offers.
 *
 * An absent name is a documented spelling — `count()` counts rows, `distinct()` dedups them, and
 * the rest fall back to {@link CurrentValue} — so it is not an error. A name that is *present*
 * and not a string is a malformed stage, and reading it as absent would silently answer a
 * different question than the caller asked: `count(<not a name>)` would become `count(*)`.
 *
 * A `group`'s sub-stream fold reads the same option off the same stages and must refuse the same
 * shapes with the same words, so it reads them through here (invariant 17).
 */
export function NamedField(stage: QueryStage): string | undefined {
  const field = stage.options?.field;
  if (field === undefined) {
    return undefined;
  }
  assert(
    typeof field === "string",
    `The '${stage.stage}' stage was given a field that is not a name`,
  );
  return field;
}

/**
 * What an aggregate reads: the named field resolved through the relation's own source, so
 * `sum("price")` is `sum("t0"."price")` rather than a member of a document built to be thrown
 * away, and a declared column stays reachable by its own index.
 */
function NamedOperand(
  relation: Relation,
  stage: QueryStage,
): Compiled | undefined {
  const field = NamedField(stage);
  return field === undefined ? undefined : relation.source.field(field);
}

function Operand(relation: Relation, stage: QueryStage): Compiled {
  return NamedOperand(relation, stage) ?? CurrentValue(relation);
}

/** The one spelling of an aggregate call, and the one owner of its `DISTINCT ` prefix. */
function Applied(func: string, argument: string, distinct = false): string {
  return `${func}(${distinct ? DEDUPED : ""}${argument})`;
}

/** ReQL's sum of an empty stream is 0, where a bare `sum` over zero rows is NULL. */
export const Total: Aggregation = (operand, distinct) =>
  AsFloat(
    `COALESCE(${Applied(SUM, Numeric(operand).sql, distinct)}, ${EMPTY_SUM})`,
  );

export const Mean: Aggregation = (operand, distinct) =>
  AsFloat(Applied(AVERAGE, Numeric(operand).sql, distinct));

/** Both orderings share one rule and one cast — see {@link Minimum}. */
function Extremum(func: string): Aggregation {
  return (operand, distinct) => {
    const ordered = ORDERED_KINDS[operand.type.kind]
      ? operand
      : Numeric(operand);
    const applied = Applied(func, ordered.sql, distinct);
    return ordered.type.kind === "float"
      ? AsFloat(applied)
      : { sql: `(${applied})`, type: ordered.type };
  };
}

/**
 * `min` over the kinds PostgreSQL orders, and over a numeric reading of the rest.
 *
 * There is no `min(boolean)` and no `min(jsonb)` — an array is a jsonb value physically — so an
 * operand of either kind would raise `42883` and lose the whole statement. Reading it as a number
 * first is the answer `arr_min`/`arr_max` already give and the one the interface documents.
 *
 * The result keeps the operand's own type and is cast only where that type is numeric. A cast
 * here applies to the aggregate's *result* — once, after every row has been reduced to it — so a
 * uniform one is not a harmless extra: `min(<text>)::double precision` raises `22P02` on that one
 * result whenever it is not a number, and `min(<timestamp>)::double precision` is refused at
 * *plan* time with `42846`, which means it could never read a row on any dataset at all. Casting
 * exactly where the result is a number is what keeps a numeric one from reaching the driver as an
 * unparsed string (invariant 1) without breaking the other two readings.
 */
export const Minimum: Aggregation = Extremum(MINIMUM);

/** `max` under {@link Minimum}'s rule, which both orderings share. */
export const Maximum: Aggregation = Extremum(MAXIMUM);

/**
 * Counts rows, or the *distinct* values of an operand.
 *
 * An absent operand is a documented spelling rather than a missing argument: `count(*)` needs no
 * operand at all and counts the rows themselves, which is the reading a caller that named no field
 * asked for. A *present* operand counts its distinct values, which is what the contract asserts —
 * `count("car")` against `new Set(cars).size`. Which of the two applies is the caller's to decide.
 * The `bigint` both spellings return reaches the driver as a *string*, which is what the cast is
 * for.
 */
export function Tally(operand?: Compiled): Compiled {
  const named = operand !== undefined;
  return AsFloat(Applied(COUNT, named ? operand.sql : ALL_ROWS, named));
}

/**
 * Moves the relation into value mode over the one row an aggregate yields.
 *
 * The order terms go with it: `SELECT sum(x) … ORDER BY y` with no `GROUP BY` raises
 * `42803 column "y" must appear in the GROUP BY clause`, and since no ordering can change an
 * aggregate, clearing them is correct rather than merely convenient. `aggregated` is what blocks
 * the next stage that would filter or reorder the result, and it survives exactly one stage —
 * a wrap drops it, which is what leaves `count().default(0)` free to read the aggregate.
 *
 * Dropping the terms is the one place this pipeline discards compiled text, which is legal only
 * because an order term never carries a `$n`: they are built from `source.field(name)` with no
 * default, so nothing in them was decoded. {@link AbsorbOrder} is where that is asserted rather
 * than assumed, and it is the same door a subquery's aggregate takes to *keep* the terms — an
 * `orderBy` that ever decoded an argument would have to render its terms into a subselect here
 * instead, or the statement binds a parameter no fragment references and the driver rejects the
 * whole query (invariant 12, one layer up).
 */
function SetAggregate(relation: Relation, value: Compiled): Relation {
  const aggregate = SetProjection(relation, value);
  AbsorbOrder(aggregate);
  aggregate.single = true;
  aggregate.aggregated = true;
  return aggregate;
}

function AggregateStage(aggregate: Aggregation): PipelineStage {
  return (relation, stage, context) => {
    const prepared = Prepare(relation, AGGREGATE_BLOCKERS, context);
    return SetAggregate(prepared, aggregate(Operand(prepared, stage)));
  };
}

/** The one aggregate that reads the *presence* of its field rather than the field. */
const CountStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, AGGREGATE_BLOCKERS, context);
  return SetAggregate(prepared, Tally(NamedOperand(prepared, stage)));
};

/**
 * Dedups the relation, on one named field or on whole rows.
 *
 * A named field also becomes the projection, so `distinct("isElectric")` yields a stream of
 * booleans; without one the relation keeps whatever it was already yielding and `SELECT DISTINCT`
 * compares that. Either way it stays a stream — unlike the five aggregates, this one reduces the
 * rows without reducing them to a single value.
 */
const DistinctStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, DISTINCT_BLOCKERS, context);
  prepared.distinct = true;
  const field = NamedField(stage);
  if (field === undefined) {
    return prepared;
  }
  return SetProjection(prepared, prepared.source.field(field));
};

/**
 * The stages that reduce a stream to one value, and the one that dedups it.
 *
 * The spellings themselves — {@link Total}, {@link Mean}, {@link Minimum}, {@link Maximum} and
 * {@link Tally} — are exported, because a `group`'s sub-stream fold reduces a group's rows with
 * the same five aggregates and has to reduce them the same way (invariant 17). A second table of
 * them there would be free to answer `sum` one way outside a group and another way inside it with
 * nothing failing, and it would land on {@link Minimum}'s "cast only where the result is numeric"
 * rule first, because that is the one a reimplementation would simplify away. They are exported
 * already applied, so the fold names no PostgreSQL function of its own and cannot reach a third
 * ordering the rule was never written for.
 */
export const AGGREGATE_STAGES: PipelineStageMap = {
  [SUM]: AggregateStage(Total),
  [AVERAGE]: AggregateStage(Mean),
  [MINIMUM]: AggregateStage(Minimum),
  [MAXIMUM]: AggregateStage(Maximum),
  [COUNT]: CountStage,
  [DISTINCT]: DistinctStage,
};
