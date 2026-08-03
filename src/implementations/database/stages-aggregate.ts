import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import {
  CurrentValue,
  Prepare,
  type Relation,
  type RelationFlag,
  SetProjection,
} from "./relation";
import type { Compiled } from "./sql";
import { AsFloat, Numeric, ORDERED_KINDS } from "./stage";

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

type Aggregation = (operand: Compiled) => Compiled;

/**
 * The field an aggregate reads, or nothing for the whole-value reading each of them also offers.
 *
 * An absent name is a documented spelling — `count()` counts rows, `distinct()` dedups them, and
 * the rest fall back to {@link CurrentValue} — so it is not an error. A name that is *present*
 * and not a string is a malformed stage, and reading it as absent would silently answer a
 * different question than the caller asked: `count(<not a name>)` would become `count(*)`.
 */
function NamedField(stage: QueryStage): string | undefined {
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
function Operand(relation: Relation, stage: QueryStage): Compiled {
  const field = NamedField(stage);
  return field === undefined
    ? CurrentValue(relation)
    : relation.source.field(field);
}

function Applied(func: string, argument: string): string {
  return `${func}(${argument})`;
}

/** ReQL's sum of an empty stream is 0, where a bare `sum` over zero rows is NULL. */
const Total: Aggregation = (operand) =>
  AsFloat(`COALESCE(${Applied(SUM, Numeric(operand).sql)}, ${EMPTY_SUM})`);

const Mean: Aggregation = (operand) =>
  AsFloat(Applied(AVERAGE, Numeric(operand).sql));

/**
 * `min`/`max` over the kinds PostgreSQL orders, and over a numeric reading of the rest.
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
function Extremum(func: string): Aggregation {
  return (operand) => {
    const ordered = ORDERED_KINDS[operand.type.kind]
      ? operand
      : Numeric(operand);
    const applied = Applied(func, ordered.sql);
    return ordered.type.kind === "float"
      ? AsFloat(applied)
      : { sql: `(${applied})`, type: ordered.type };
  };
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
 * default, so nothing in them was decoded. An `orderBy` that ever decoded an argument would have
 * to render its terms into a subselect here instead, or the statement binds a parameter no
 * fragment references and the driver rejects the whole query (invariant 12, one layer up).
 */
function SetAggregate(relation: Relation, value: Compiled): Relation {
  const aggregate = SetProjection(relation, value);
  aggregate.orderBy = [];
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

/**
 * Counts rows, or the *distinct* values of a named field.
 *
 * The distinct reading is what the contract asserts — `count("car")` against
 * `new Set(cars).size` — and it is why this one stage reads the presence of the field rather
 * than the field: `count(*)` needs no operand at all, so a field-less count materializes no
 * document to count. The `bigint` both spellings return reaches the driver as a *string*, which
 * is what the cast is for.
 */
const CountStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, AGGREGATE_BLOCKERS, context);
  const field = NamedField(stage);
  const counted =
    field === undefined
      ? ALL_ROWS
      : `DISTINCT ${prepared.source.field(field).sql}`;
  return SetAggregate(prepared, AsFloat(Applied(COUNT, counted)));
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

/** The stages that reduce a stream to one value, and the one that dedups it. */
export const AGGREGATE_STAGES: PipelineStageMap = {
  [SUM]: AggregateStage(Total),
  [AVERAGE]: AggregateStage(Mean),
  [MINIMUM]: AggregateStage(Extremum(MINIMUM)),
  [MAXIMUM]: AggregateStage(Extremum(MAXIMUM)),
  [COUNT]: CountStage,
  [DISTINCT]: DistinctStage,
};
