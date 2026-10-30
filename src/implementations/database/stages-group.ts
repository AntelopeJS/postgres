import assert from "node:assert";

import { ArrayOf } from "./types";
import { Collected } from "./jsonb";
import { AsJson } from "./readings";
import type { Compiled } from "./sql";
import { DecodeFunction, RecordedLambda } from "./value";
import type { QueryStage } from "./utils";
import { FIRST_OPERAND, RequireOperand } from "./stage";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import type { DecodingContext, SubqueryProvider } from "./context";
import {
  BuildDocument,
  type DocumentMember,
  JsonRowSource,
  type RowSource,
} from "./row-source";
import {
  type Aggregation,
  Maximum,
  Mean,
  Minimum,
  NamedField,
  Tally,
  Total,
} from "./stages-aggregate";
import {
  CurrentValue,
  IndexColumns,
  type Relation,
  SetProjection,
} from "./relation";
import { Prepare, type RelationFlag } from "./render";
import { IsString } from "./guards";

/**
 * What a sub-stream has reduced a group's rows to so far.
 *
 * `value` is what one row yields and `source` is how a field name resolves against it — the pair
 * {@link Relation} carries as its projection and its row source, and carried here for the same
 * reason: a named field has to reach the table's own typed column, so `sum("age")` inside a group
 * is the text `sum("age")` outside one. Resolving a name out of the materialized
 * document instead would spell that document once per member of the mapper and lose nothing but
 * the resemblance.
 *
 * `distinct` is a pending dedup rather than a stage of its own, because `distinct` leaves a stream:
 * only the terminal that follows it can spell the `DISTINCT`, and which spelling that is differs
 * per terminal.
 */
interface SubStream {
  source: RowSource;
  value: Compiled;
  distinct: boolean;
}

/**
 * One step of a sub-stream fold: a state means it continues, a {@link Compiled} means it ended.
 */
type SubStreamStage = (
  state: SubStream,
  stage: QueryStage,
  context: DecodingContext,
) => SubStream | Compiled;

type SubStreamStageMap = Record<string, SubStreamStage>;

const MAP = "map";
const DISTINCT = "distinct";
const COUNT = "count";
const SUM = "sum";
const AVERAGE = "avg";
const MINIMUM = "min";
const MAXIMUM = "max";

/** What an aggregate reads: the field it named, or whatever the sub-stream currently yields. */
function Operand(state: SubStream, stage: QueryStage): Compiled {
  const field = NamedField(stage);
  return field === undefined ? state.value : state.source.field(field);
}

/** A new value and the source that addresses it, which is what a projection is one level up. */
function Revalued(state: SubStream, value: Compiled): SubStream {
  return {
    source: new JsonRowSource(value),
    value,
    distinct: state.distinct,
  };
}

const MapSubStream: SubStreamStage = (state, stage, context) => {
  const body = DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
    state.source,
  ]);
  return Revalued(state, RequireOperand(body, stage, FIRST_OPERAND));
};

const DistinctSubStream: SubStreamStage = (state, stage) => {
  const deduped: SubStream = { ...state, distinct: true };
  const field = NamedField(stage);
  if (field === undefined) {
    return deduped;
  }
  return Revalued(deduped, state.source.field(field));
};

/** The one terminal that reads the *presence* of a row rather than the value it yields. */
const CountSubStream: SubStreamStage = (state, stage) => {
  const field = NamedField(stage);
  if (field !== undefined) {
    return Tally(state.source.field(field));
  }
  return Tally(state.distinct ? state.value : undefined);
};

function AggregateSubStream(aggregate: Aggregation): SubStreamStage {
  return (state, stage) => aggregate(Operand(state, stage), state.distinct);
}

/**
 * The stages a sub-stream accepts, each answering a state that continues the fold or the value
 * that ends it.
 *
 * **Two terminals, and only ever one of them.** A sub-stream either reduced its group to a single
 * value — `count`, `sum`, `avg`, `min`, `max` — or it is still a stream, being the bare parameter
 * or the result of a `map` or a `distinct`, in which case {@link CollectedRows} answers the
 * group's rows as one jsonb array. That second reading is what makes a `distinct` in a group's
 * mapper answer an array, and it comes free with the bare-stream case rather than as a rule of its
 * own.
 *
 * The five aggregate spellings are imported already applied from `stages-aggregate.ts`, so this
 * module names no PostgreSQL function of its own, and the collected form goes
 * through `jsonb.ts:Collected` for the same reason — `AGGREGATE_STAGES` is where the consequence of
 * a second table of either is written down.
 *
 * **`count` ignores {@link SubStream.value}, and that is deliberate.** A field-less `count` is
 * `count(*)` however the rows were mapped, because `count(<expr>)` skips NULLs and would answer a
 * different number than a bare `count()` the moment a mapped key were absent on some row — while
 * the contract asserts the two agree. A *pending dedup* is the one thing it does read, since
 * `distinct("f").count()` is asking for `count(DISTINCT f)` rather than for the row count — though
 * a field named on the `count` itself supersedes that dedup, so `distinct("a").count("b")` is
 * `count(DISTINCT b)` over every row. The shapes where it would discard a value the fold had
 * already decoded never arrive here at all — see {@link SubStreamProvider}.
 *
 * **What is missing is missing because nothing reaches it.** `filter` has an obvious spelling here
 * — `sum(x) FILTER (WHERE p)` — and is unbuilt rather than impossible; it is the one most likely
 * to be asked for next. Everything else a stream can record is refused by name, and the message
 * says it is the sub-stream position that cannot take it, because the same stage is perfectly
 * legal on the query one level out.
 */
const SUB_STREAM_STAGES = {
  [MAP]: MapSubStream,
  [DISTINCT]: DistinctSubStream,
  [COUNT]: CountSubStream,
  [SUM]: AggregateSubStream(Total),
  [AVERAGE]: AggregateSubStream(Mean),
  [MINIMUM]: AggregateSubStream(Minimum),
  [MAXIMUM]: AggregateSubStream(Maximum),
} satisfies SubStreamStageMap;

function IsSubStreamStage(
  name: string,
): name is keyof typeof SUB_STREAM_STAGES {
  return Object.hasOwn(SUB_STREAM_STAGES, name);
}

function IsTerminal(step: SubStream | Compiled): step is Compiled {
  return "sql" in step;
}

/** The group's rows as one jsonb array — see {@link SUB_STREAM_STAGES} for when that is the answer. */
function CollectedRows(state: SubStream): Compiled {
  return {
    sql: Collected(undefined, AsJson(state.value).sql, state.distinct),
    type: ArrayOf(state.value.type),
  };
}

function RefuseSubStreamStage(stage: QueryStage): never {
  throw new Error(
    `The '${stage.stage}' stage cannot appear in a group's sub-stream,` +
      " though it is legal on the query outside the group",
  );
}

function RefuseSecondTerminal(stage: QueryStage): never {
  throw new Error(
    `The '${stage.stage}' stage cannot follow an aggregate in a group's sub-stream,` +
      " since an aggregate may not read another one",
  );
}

function StepSubStream(
  state: SubStream | Compiled,
  stage: QueryStage,
  context: DecodingContext,
): SubStream | Compiled {
  if (IsTerminal(state)) {
    RefuseSecondTerminal(stage);
  }
  if (!IsSubStreamStage(stage.stage)) {
    RefuseSubStreamStage(stage);
  }
  return SUB_STREAM_STAGES[stage.stage](state, stage, context);
}

/** A run of `map`s ending in a field-less `count`, whose answer is `count(*)` whatever they did. */
function IsRowCount(stages: QueryStage[]): boolean {
  const last = stages[stages.length - 1];
  if (!last || last.stage !== COUNT || NamedField(last) !== undefined) {
    return false;
  }
  return stages.slice(0, -1).every((stage) => stage.stage === MAP);
}

/**
 * The {@link SubqueryProvider} a `group` binds its stream parameter to, over the rows of one group.
 *
 * Whatever the mapper does with that parameter arrives at `subquery.ts:CompileSubquery` as a stage
 * array headed by an `arg`, which hands the remaining stages here — see that function for why the
 * hand-off cannot go through the relation compiler. The stages are folded through
 * {@link SUB_STREAM_STAGES}, and the fold is the whole of what keeps one aggregate out of another's
 * argument: the first terminal ends it, and anything after one is refused rather than nested.
 *
 * The seed is read off the relation as the group found it, before any projection, and **once**,
 * before any of the mapper is decoded, so a sub-stream cannot change what the group selects after a
 * `$n` has been spent on it. The state it seeds is never mutated, since one mapper
 * binds this provider as many times as it names the parameter and each fold has to start where the
 * others did.
 *
 * **A field-less `count` under nothing but `map`s decodes none of them**, which is the same rule
 * applied to the stages rather than to the seed. {@link SUB_STREAM_STAGES} is where the reason its
 * answer does not depend on them is written down; folding anyway would decode a mapper body, bind
 * its constants, and then discard the text holding them — leaving the statement binding a `$n` no
 * fragment references, which fails the bind `relation.ts:AbsorbOrder` names. A body this compiler
 * could not
 * have decoded — or a `map` carrying none at all — goes unrefused with them, which is the correct
 * `count(*)` either way since `map` is one-to-one. Deciding the shape before decoding anything is
 * what `join` and `lookup` do for the same reason.
 *
 * A `distinct` ahead of the `count` is what takes the shortcut away, and so is any other stage: a
 * dedup makes the mapped value the thing being counted rather than the rows, and anything else in
 * that run is either a second terminal or a stage this position refuses — each of which the fold
 * has to run to reach.
 */
export function SubStreamProvider(
  relation: Relation,
  context: DecodingContext,
): SubqueryProvider {
  const seed: SubStream = {
    source: relation.source,
    value: CurrentValue(relation),
    distinct: false,
  };
  return (stages) => {
    if (IsRowCount(stages)) {
      return Tally();
    }
    const folded = stages.reduce<SubStream | Compiled>(
      (state, stage) => StepSubStream(state, stage, context),
      seed,
    );
    return IsTerminal(folded) ? folded : CollectedRows(folded);
  };
}

/**
 * Everything that blocks a whole-stream aggregate, plus an existing ordering.
 * A deliberate fourth copy of the five flags: each list names a different reason for the same set.
 */
const GROUP_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
  "ordered",
];

const SINGLE_COLUMN = 1;
const ONLY_COLUMN = 0;

function GroupName(stage: QueryStage): string {
  const name: unknown = stage.options?.index;
  assert(
    IsString(name),
    "The 'group' stage is missing the index or field to group on",
  );
  return name;
}

/** One column is the value itself; a compound index is a document of its columns. */
function GroupValue(columns: DocumentMember[]): Compiled {
  return columns.length === SINGLE_COLUMN
    ? columns[ONLY_COLUMN]
    : BuildDocument(columns);
}

const GroupStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, GROUP_BLOCKERS, context);
  const columns = IndexColumns(prepared, GroupName(stage));
  const value = GroupValue(columns);
  prepared.groupBy.push(...columns);
  const mapped = DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
    SubStreamProvider(prepared, context),
    value,
  ]);
  const grouped = SetProjection(
    prepared,
    RequireOperand(mapped, stage, FIRST_OPERAND),
  );
  grouped.aggregated = true;
  return grouped;
};

/**
 * Folds the stream into one row per group, with the mapper's result as each row's value.
 *
 * **One `GROUP BY`, not a query per group.** The rows a sub-stream aggregates are the rows the
 * pipeline has already selected, restricted to one group, which is what `GROUP BY` means; the
 * mapper's members are aggregate expressions in the one select list over it. Rendering the keys and
 * then a correlated subselect per member per group would re-read the table once per member and make
 * the group key the only thing the outer query computes.
 *
 * **The shape is settled before anything is decoded**: the columns are resolved and
 * the group value is built ahead of the mapper's body, because a handler that decoded the body and
 * then changed its mind about the grouping would have bound a `$n` no fragment references. Both
 * lambda parameters are bound through `value.ts:WithBoundArguments`, which unbinds them however the
 * decode ends — a mapper that throws mid-decode would otherwise leave the stream parameter bound
 * for the *next* query compiled on the same context.
 *
 * **The group value is built once and used twice**, once as the term and once inside the mapper's
 * result, for the reason `Relation.groupBy` holds compiled terms rather than text. A compound index
 * groups by each of its columns — each staying a bare, indexable column — and hands the mapper a
 * document of them, built through the shared `BuildDocument` so a jsonb-backed index field keeps
 * the nulls the caller stored inside it. Every column of that document is itself a term, so the
 * select list names nothing the `GROUP BY` does not.
 *
 * **`42803` cannot bite, and this is the argument rather than a measurement.** Every select-list
 * expression comes from the mapper, and the mapper reaches exactly two things: the group value,
 * which *is* the term, and sub-stream values, which are aggregates or a `jsonb_agg`. The outer row
 * is not in scope for it — the obvious future extension, letting the mapper see the row, breaks
 * this silently on datasets where every group happens to have one row.
 *
 * The relation is left `aggregated` and **not** `single`: a later `count()` therefore wraps and
 * counts the groups, which is right, and there are many of them. A write after it is refused with
 * *"A row-mode relation must carry the origin of its table"* by `SetProjection` clearing the origin,
 * which is the same rule every reshaping stage lands on and is deliberately not restated here — a
 * second refusal would be the one that drifts, since a `group` that somehow kept its origin would
 * fail the new check and pass the old one.
 */
export const GROUP_STAGES: PipelineStageMap = {
  group: GroupStage,
};
