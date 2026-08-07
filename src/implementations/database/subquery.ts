import type { DecodingContext } from "./context";
import { Collected } from "./jsonb";
import { AsJson } from "./readings";
import {
  AbsorbOrder,
  CurrentValue,
  Prepare,
  type Relation,
  type RelationFlag,
  Render,
  SetProjection,
} from "./relation";
import type { Compiled } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { ArrayOf } from "./types";
import type { QueryStage } from "./utils";

/**
 * What has already decided *which* rows there are blocks the aggregate from absorbing.
 *
 * Shorter than `stages-aggregate.ts`'s list by `projection`, and that difference is the point: the
 * projection is exactly what this aggregate collects, so blocking on it would wrap every nested
 * query that ever named a field. `aggregated` is absent because a relation that has already
 * aggregated answers one row and takes the single-row branch instead, never this one.
 */
const SUBQUERY_BLOCKERS: readonly RelationFlag[] = [
  "limit",
  "offset",
  "distinct",
];

/**
 * Collects every row of a nested query into one jsonb array, in the order the query asked for.
 *
 * The aggregate is **absorbed into the relation** rather than wrapped around a rendering of it, the
 * way `stages-aggregate.ts:SetAggregate` absorbs a stream aggregate: only from inside can
 * `jsonb_agg` name the relation's own order terms, and PostgreSQL does not promise a subquery's
 * `ORDER BY` survives into an outer aggregate at all — it is observed today and is a plan change
 * away from not being. Both sibling backends preserve it. It also removes a select level rather
 * than adding one.
 *
 * The terms leave through {@link AbsorbOrder}, which is the same door the stream aggregate takes
 * and which asserts invariant 19 for both. Here they are re-emitted rather than discarded, so a
 * term holding a `$n` would not break *this* bind — the assertion belongs to the door, not to the
 * caller, and one of its two callers genuinely throws the text away.
 *
 * The projected column is read as jsonb first. `jsonb_agg` takes `anyelement` and so would accept
 * a declared scalar column as it is, but then each element would be spelled by that type's own
 * output function rather than by `to_jsonb`, which is what every other jsonb-valued fragment this
 * compiler builds goes through — one spelling for the elements of an array is worth the cast.
 *
 * The element type is read off the projection **before** {@link AsJson}, not after it: a cast to
 * the bottom type answers a bottom-typed value, so `ArrayOf` over the cast would widen a stream of
 * timestamps to raw json and lose the revival the decoder does from the type descriptor alone.
 */
function Aggregated(relation: Relation, context: DecodingContext): Compiled {
  const prepared = Prepare(relation, SUBQUERY_BLOCKERS, context);
  const value = CurrentValue(prepared);
  const type = ArrayOf(value.type);
  const collected = Collected(AbsorbOrder(prepared), AsJson(value).sql);
  return {
    sql: `(${Render(SetProjection(prepared, { sql: collected, type }))})`,
    type,
  };
}

const ARG_STAGE = "arg";

/** A lambda parameter bound to a compilation of its own, with the rest of the stages handed to it. */
function ProvidedSubquery(
  stages: QueryStage[],
  context: DecodingContext,
): Compiled | undefined {
  const [head, ...rest] = stages;
  if (head?.stage !== ARG_STAGE) {
    return undefined;
  }
  const binding = context.arg(head.args[FIRST_OPERAND]);
  return typeof binding === "function" ? binding(rest) : undefined;
}

/**
 * Compiles a whole query appearing as a *value* into a scalar subselect.
 *
 * A query headed by an `arg` is not a query over a table at all — it is a lambda parameter the
 * enclosing stage bound to a `SubqueryProvider`, which is how a `group`'s mapper reaches the rows
 * of its own group. The test for one runs **before** {@link DecodingContext.relation}, and that
 * order is the whole reason it lives here: such a stage array carries no `schema`/`instance`/`table`
 * prefix, so `BuildRoot` refuses it with *"A table query must open with schema, instance, table"*
 * before anything can notice what the head actually is.
 *
 * It is also why `stages-core.ts:ArgStage`'s own *function* branch stays unreached. A `group`
 * mapper's **stream** parameter is a `Query` subclass, and so is every value derived from it —
 * `stream.count()` is a `Datum`, which extends `Query` too — so every use of it arrives here rather
 * than at the expression compiler. The mapper's **group** parameter is a `ValueProxy` and does
 * reach `ArgStage`, which answers it from its `Compiled` binding; it is the function branch
 * specifically, not the stage, that nothing arrives at. Routing a sub-stream through it instead
 * would pass `[stage]`, the head alone, dropping the aggregate that follows it and answering the
 * group's whole document. The stages after the head are what say which aggregate was asked for, so
 * they go with it.
 *
 * The relation's own answer to `single` decides what the value is: a single-row query is the
 * subselect itself, which yields SQL NULL — and so `null` to the caller — when it read no row,
 * while a stream is aggregated into a jsonb array so that more than one row is an answer rather
 * than `21000 more than one row returned by a subquery used as an expression`.
 *
 * The projection is **set** to whatever the relation currently yields before either branch
 * renders, which is what keeps exactly one column in the subselect: a row-mode relation renders
 * its physical column list, and `42601 subquery must return only one column` is what
 * `table.get(k)` used as a value would otherwise be. It is idempotent over a relation that
 * already projects.
 *
 * Correlation needs nothing here. A key argument compiled from the enclosing lambda's binding
 * already spells the outer relation's own column, and the subselect is emitted where that alias is
 * in scope.
 */
export function CompileSubquery(
  stages: QueryStage[],
  context: DecodingContext,
): Compiled {
  const provided = ProvidedSubquery(stages, context);
  if (provided) {
    return provided;
  }
  const relation = context.relation(stages);
  if (!relation.single) {
    return Aggregated(relation, context);
  }
  const value = CurrentValue(relation);
  return {
    sql: `(${Render(SetProjection(relation, value))})`,
    type: value.type,
  };
}
