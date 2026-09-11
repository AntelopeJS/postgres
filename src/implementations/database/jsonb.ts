import assert from "node:assert";

import { PhysicalType, TEXT } from "./types";
import {
  type Compiled,
  QualifiedColumn,
  QuoteIdentifier,
  QuoteLiteral,
} from "./sql";

/** A `text[]` of literal keys, which is the operand every key-set operator takes. */
export function TextArray(names: readonly string[]): string {
  const literals = names.map(QuoteLiteral);
  return `array[${literals.join(", ")}]::${PhysicalType(TEXT)}[]`;
}

/** jsonb's own names for the two container kinds, which every guard in the compiler reads. */
export const OBJECT_TYPEOF = "object";
export const ARRAY_TYPEOF = "array";

/** Yields NULL rather than an error when the operand is not the expected jsonb container. */
export function GuardJson(
  value: Compiled,
  expected: string,
  body: string,
): string {
  return `(CASE WHEN jsonb_typeof(${value.sql}) = '${expected}' THEN ${body} END)`;
}

type ColumnRendering = (column: string) => string;

export interface HeldValue {
  value: string;
  column: string;
  alias: string;
  select: ColumnRendering;
  guard: ColumnRendering;
}

/**
 * Guards a value the guard itself has to read, without spelling that value twice.
 *
 * {@link GuardJson} emits its operand once per branch, which is affordable for a bare column and
 * is not for a materialized document — and these constructs chain, so N of them spell 2^N copies
 * of the whole prior expression. Holding the value on a one-column derived table names it instead:
 * the select list and the guard both read the alias, and the value is emitted exactly once. A row
 * that fails the guard yields no row, which as a scalar subselect reaches the caller as NULL — the
 * same reading {@link GuardJson} gives.
 *
 * **It holds once in the *text*, not once at run time.** The planner pulls a one-row subquery up
 * and substitutes the held expression into both the output and the one-time filter, so the value is
 * evaluated twice per row either way; measured at +25 % execution against the same fragment
 * unguarded. What this buys is text that stays linear as these constructs chain, which is the whole
 * of the claim — a caller wanting the *evaluation* to happen once needs a lateral off the relation.
 */
export function HeldOnce(held: HeldValue): string {
  const relation = QuoteIdentifier(held.alias);
  const column = QualifiedColumn(held.alias, held.column);
  const source = `(SELECT ${held.value} AS ${QuoteIdentifier(held.column)})`;
  const selected = held.select(column);
  return `(SELECT ${selected} FROM ${source} AS ${relation} WHERE ${held.guard(column)})`;
}

export const VALUE_COLUMN = "value";
export const ORDINAL_COLUMN = "ord";

/**
 * What an aggregation over zero rows must answer instead of NULL, spelled once.
 *
 * `jsonb_agg` yields NULL over an empty input, which would turn an empty container into a null for
 * every stage downstream — and the same is true of a nested query that read no row. Both callers
 * coalesce onto this literal, and a second spelling would be free to drift from this one with
 * nothing failing.
 */
export const EMPTY_ARRAY = "'[]'::jsonb";
const ORDINALITY = "WITH ORDINALITY";

export function WalkColumn(alias: string, name: string): string {
  return QualifiedColumn(alias, name);
}

/**
 * Aggregates rows into a jsonb array in a stated order, empty rather than NULL over none of them.
 *
 * `jsonb_agg` preserves input order in practice but does not promise it, so whatever decides the
 * order is named explicitly — a container walk names its ordinality column, and a nested query
 * names the terms its own `orderBy` carried. And it yields NULL rather than `'[]'` over zero rows,
 * which would turn an empty container into a null for every stage downstream.
 *
 * The order is a fragment rather than an alias so that the one spelling of `jsonb_agg(… ORDER BY
 * …)` serves both: a second one would be free to drop the `ORDER BY`, or the
 * `COALESCE`, with nothing failing. It is absent only where there is nothing to order by — a
 * nested query the caller never ordered — and never where a walk decided one.
 *
 * `distinct` dedups the elements, which is what a group's sub-stream asks for after a `distinct`
 * stage. It lives here rather than in that caller for the reason above and for one more that no
 * test can reach: a group is never empty, so a local `jsonb_agg(DISTINCT …)` would be free to drop
 * the `COALESCE` and nothing would ever observe the difference.
 *
 * The two channels are mutually exclusive, and the assertion is what says so at the one place that
 * can: `jsonb_agg(DISTINCT x ORDER BY y)` requires `y` to appear in the argument list, so a caller
 * ordering by anything else is `42P10` rather than a wrong answer. Nothing asks for both — a
 * sub-stream refuses `orderBy` outright, and a nested query never dedups here.
 */
export function Collected(
  order: string | undefined,
  target: string,
  distinct = false,
): string {
  assert(
    !distinct || order === undefined,
    "A collected aggregate orders its elements or dedups them, never both",
  );
  const deduped = distinct ? "DISTINCT " : "";
  const ordered = order === undefined ? "" : ` ORDER BY ${order}`;
  return `COALESCE(jsonb_agg(${deduped}${target}${ordered}), ${EMPTY_ARRAY})`;
}

export interface ElementWalk {
  func: string;
  json: string;
  alias: string;
  columns: readonly string[];
  aggregate: string;
  predicate?: string;
}

/**
 * Emits an aliased scalar subselect over a set-returning function, which is the one shape a
 * container walk can take: `jsonb_array_elements`, `jsonb_object_keys` and `jsonb_each` cannot
 * appear in an expression directly.
 *
 * Every walk takes `WITH ORDINALITY` and an alias from `context.nextAlias()`, so the natural
 * order stays addressable — see {@link Collected} — and two walks in one expression, or one
 * nested inside another, never collide.
 */
export function Walk(walk: ElementWalk): string {
  const columns = [...walk.columns, ORDINAL_COLUMN]
    .map(QuoteIdentifier)
    .join(", ");
  const relation = `${QuoteIdentifier(walk.alias)}(${columns})`;
  const source = `${walk.func}(${walk.json}) ${ORDINALITY} AS ${relation}`;
  const where = walk.predicate ? ` WHERE ${walk.predicate}` : "";
  return `(SELECT ${walk.aggregate} FROM ${source}${where})`;
}
