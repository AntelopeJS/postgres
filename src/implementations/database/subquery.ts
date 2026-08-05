import type { DecodingContext } from "./context";
import {
  CurrentValue,
  OUTPUT_COLUMN,
  type Relation,
  Render,
  SetProjection,
} from "./relation";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import { AsJson, EMPTY_ARRAY } from "./stage";
import { ArrayOf } from "./types";
import type { QueryStage } from "./utils";

/**
 * Collects every row of a nested query into one jsonb array, empty rather than NULL.
 *
 * The projected column is read as jsonb first. `jsonb_agg` takes `anyelement` and so would accept
 * a declared scalar column as it is, but then each element would be spelled by that type's own
 * output function rather than by `to_jsonb`, which is what every other jsonb-valued fragment this
 * compiler builds goes through — one spelling for the elements of an array is worth the cast.
 *
 * The element type is read off the projection **before** {@link AsJson}, not after it: a cast to
 * the bottom type answers a bottom-typed value, so `ArrayOf` over the cast would widen a stream of
 * timestamps to raw json and lose the revival the decoder does from the type descriptor alone.
 *
 * `jsonb_agg` preserves the nested query's own `ORDER BY` in practice and does not promise to;
 * there is no way to spell `jsonb_agg(… ORDER BY …)` over a rendered relation, so that is a
 * documented divergence rather than something to guard.
 */
function Aggregated(
  relation: Relation,
  value: Compiled,
  context: DecodingContext,
): Compiled {
  const alias = context.nextAlias();
  const rows = Render(SetProjection(relation, AsJson(value)));
  return {
    sql:
      `(SELECT COALESCE(jsonb_agg(${QualifiedColumn(alias, OUTPUT_COLUMN)}), ${EMPTY_ARRAY})` +
      ` FROM (${rows}) AS ${QuoteIdentifier(alias)})`,
    type: ArrayOf(value.type),
  };
}

/**
 * Compiles a whole query appearing as a *value* into a scalar subselect.
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
  const relation = context.relation(stages);
  const value = CurrentValue(relation);
  if (!relation.single) {
    return Aggregated(relation, value, context);
  }
  return {
    sql: `(${Render(SetProjection(relation, value))})`,
    type: value.type,
  };
}
