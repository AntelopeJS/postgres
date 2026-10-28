import { ArrayOf } from "./types";
import { Collected } from "./jsonb";
import { AsJson } from "./readings";
import type { Compiled } from "./sql";
import { FIRST_OPERAND } from "./stage";
import type { QueryStage } from "./utils";
import { type DecodingContext, IsSubqueryProvider } from "./context";
import {
  AbsorbOrder,
  CurrentValue,
  Prepare,
  type Relation,
  type RelationFlag,
  Render,
  SetProjection,
} from "./relation";

/**
 * What has already decided *which* rows there are blocks the aggregate from absorbing.
 * Shorter than the stream list by `projection`, which is exactly what this aggregate collects.
 */
const SUBQUERY_BLOCKERS: readonly RelationFlag[] = [
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * Collects every row of a nested query into one jsonb array, in the order the query asked for.
 * Absorbed into the relation rather than wrapped, so `jsonb_agg` can name its own order terms.
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
  return IsSubqueryProvider(binding) ? binding(rest) : undefined;
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
