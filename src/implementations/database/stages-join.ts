import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { UnifyOperands } from "./coerce";
import type { DecodingContext } from "./context";
import { EMPTY_ARRAY, HeldOnce, OBJECT_TYPEOF } from "./jsonb";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { AsJson, Predicate } from "./readings";
import {
  CurrentValue,
  type JoinKind,
  Nested,
  OUTPUT_COLUMN,
  Prepare,
  type Relation,
  type RelationFlag,
  Render,
  SetProjection,
  SINGLE_ROW,
  WHERE_BLOCKERS,
} from "./relation";
import { NullableRowSource, type RowSource } from "./row-source";
import {
  type Compiled,
  QualifiedColumn,
  QuoteIdentifier,
  QuoteLiteral,
} from "./sql";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import {
  ArrayOf,
  IsArray,
  JsonOf,
  MergeShapes,
  ShapeOf,
  type SqlType,
} from "./types";
import { DecodeFunction } from "./value";

const MAPPER_OPERAND = 2;

/**
 * Everything that has already decided *which rows* there are blocks a join.
 *
 * A join changes row multiplicity, so a bound, a `DISTINCT` or an aggregate ahead of it has to
 * apply to the rows it was written against rather than to the joined result. `projection` blocks
 * for the reason every stage reading a field through the relation's source blocks it: a source over
 * a pending projection would inline that projection into the new one.
 *
 * **`ordered` deliberately does not block, and this is not an omission.** The left's `ORDER BY`
 * stays on the relation and applies to the joined result, so the ordering *key* is respected — and
 * that is all it promises: two left rows tied on the key, each matching several right rows, may
 * interleave, because nothing orders the duplicates a join produces. It is still the better answer,
 * because wrapping would push the sort into a subselect where SQL guarantees nothing about it
 * surviving at all. Adding `ordered` here would trade an ordering that holds for one that is a
 * planner's choice.
 */
const JOIN_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * What one of the two joins is, decided before anything is decoded.
 *
 * `nullable` is not `kind`'s spelling in another form: it says whether the mapper's right parameter
 * can be a row that is not there, which is exactly what an outer join adds and an inner join
 * cannot produce.
 *
 * Chosen by a ternary rather than by a lookup object, which is not the no-`switch` rule being
 * broken: that rule dispatches an open set of *names*, and this is a `boolean` with two states and
 * no room for a third. Keying a map on one costs a `String` coercion and an index signature wide
 * enough to answer `undefined` for a typo, where a ternary is total by construction.
 */
interface JoinFlavour {
  kind: JoinKind;
  nullable: boolean;
}

const INNER_FLAVOUR: JoinFlavour = { kind: "JOIN", nullable: false };
const OUTER_FLAVOUR: JoinFlavour = { kind: "LEFT JOIN", nullable: true };

function FlavourOf(stage: QueryStage): JoinFlavour {
  return stage.options?.innerOnly === true ? INNER_FLAVOUR : OUTER_FLAVOUR;
}

/**
 * Compiles the query being joined, from its own `schema`/`instance`/`table` root, and makes it a
 * FROM item addressable at a fresh alias.
 *
 * The argument is read off the stage directly rather than through `DecodeValue`, which routes a
 * query to the correlated-subquery compiler and would silently compile the right side as a value.
 * The nesting is unconditional — the right may carry a bound, an ordering, a `DISTINCT` or a
 * projection, none of which survives being spliced into a join condition, and the failure of
 * splicing is a wrong answer rather than an error.
 */
function JoinedRelation(stage: QueryStage, context: DecodingContext): Relation {
  const right = stage.args[FIRST_OPERAND];
  assert(
    right instanceof Query,
    "The 'join' stage takes another query to join against",
  );
  return Nested(context.relation(right.build()), context);
}

/**
 * Binds both lambda parameters to raw row sources, which is what leaves the condition two bare
 * qualified columns and the planner free to pick a hash or a merge join.
 *
 * Compiling either side through a materialized document would work and would defeat that
 * silently — invariant 11's argument one layer up. It goes through {@link Predicate} for invariant
 * 13's reason, and is parenthesised here because a bare disjunction would rebind against whatever
 * the condition is later composed with (invariant 5).
 */
function Condition(
  stage: QueryStage,
  sources: RowSource[],
  context: DecodingContext,
): string {
  const body = DecodeFunction(stage.args[SECOND_OPERAND], context, sources);
  const matched = RequireOperand(body, stage, SECOND_OPERAND);
  return `(${Predicate(matched).sql})`;
}

/**
 * The source the mapper reads the right row through, which is the nested right's own unless a
 * missed row is possible.
 *
 * A value-mode right needs no wrapper either: its `toJson()` *is* the projected column, genuinely
 * NULL on a miss, where a row-mode one builds a document out of columns that are all NULL and so
 * answers `{}`. See {@link NullableRowSource} for what the wrapper does and does not guard.
 */
function MapperSource(right: Relation, flavour: JoinFlavour): RowSource {
  if (!flavour.nullable || !right.origin) {
    return right.source;
  }
  return new NullableRowSource(right.source);
}

/**
 * Brings a second query into the pipeline as a `JOIN`, with the mapper's result as the projection.
 *
 * One handler serves `join` and `joinInner`, which the contract records as the same stage under
 * `options.innerOnly`. The shape is decided before anything is decoded (ground rule 1): a handler
 * that decoded a lambda and then changed its mind about the join it wanted would have bound a `$n`
 * no fragment references.
 *
 * The mapper's result is always the new projection, so a join always leaves row mode and drops the
 * origin — which is what makes a write after one refused by `RequireOrigin` rather than by a check
 * this module has to remember to make.
 */
const JoinStage: PipelineStage = (relation, stage, context) => {
  const flavour = FlavourOf(stage);
  const prepared = Prepare(relation, JOIN_BLOCKERS, context);
  const right = JoinedRelation(stage, context);
  prepared.joins.push({
    kind: flavour.kind,
    from: right.from,
    alias: right.alias,
    on: Condition(stage, [prepared.source, right.source], context),
  });
  const mapped = DecodeFunction(stage.args[MAPPER_OPERAND], context, [
    prepared.source,
    MapperSource(right, flavour),
  ]);
  return SetProjection(prepared, RequireOperand(mapped, stage, MAPPER_OPERAND));
};

/**
 * What has already reshaped the rows blocks a lookup, and a row bound deliberately does not.
 *
 * `projection` blocks for the reason every stage reading a field through the relation's source
 * blocks it: the local key is resolved against that source, and a source over a pending projection
 * would inline it into the new one. `distinct` and `aggregated` block because the lateral's
 * correlation reads a row of the relation, which neither of them still has.
 *
 * **`limit` and `offset` are absent, which is where this list is genuinely shorter than
 * {@link JOIN_BLOCKERS}.** A lateral bounded to one row cannot change how many rows there are, so a
 * bound that was already decided still selects exactly the rows it selected. Adding them would cost
 * a subselect level on every `slice(…).lookup(…)` and answer the same question.
 *
 * **That the lateral answers exactly one row is this module's obligation, not `relation.ts`'s.**
 * Nothing about a join clause bounds what it joins; {@link OneRowLateral}'s `LIMIT` and
 * {@link CollectedLateral}'s aggregate are the whole of what makes this list safe to be shorter. A
 * lateral that stopped being one-for-one would multiply a `slice`'s rows *after* the bound that
 * chose them, and nothing here would fail.
 */
const LOOKUP_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "distinct",
  "aggregated",
];

const LATERAL_KIND: JoinKind = "LEFT JOIN LATERAL";

/**
 * The whole `ON` of the lateral, which carries no condition of its own.
 *
 * The correlation lives inside the subselect, where it can reach the left's alias and be pushed
 * onto the right's own `WHERE`. Invariant 5 is about fragments that are later composed and an `ON`
 * is composed with nothing, so `"(true)"` would be cargo — see `JoinClause` in `relation.ts`.
 */
const UNCONDITIONAL = "true";

const CONTAINS = "@>";
const ARRAY_KIND: SqlType["kind"] = "array";
const HELD_COLUMN = "looked";

interface LookupKeys {
  localKey: string;
  otherKey: string;
}

function KeysOf(stage: QueryStage): LookupKeys {
  const localKey = stage.options?.localKey;
  const otherKey = stage.options?.otherKey;
  assert(
    typeof localKey === "string" && typeof otherKey === "string",
    "The 'lookup' stage names the local key and the other key with strings",
  );
  return { localKey, otherKey };
}

type Correlation = (other: Compiled, local: Compiled) => string;
type Materialization = (right: Relation, context: DecodingContext) => string;
type Replacement = (value: SqlType) => SqlType;

/**
 * The two shapes a lookup takes, chosen from the *declared* type of the local key.
 *
 * A key declared as an array points at a list of rows and a key declared as anything else points at
 * one, and that is a fact about the schema rather than about a value — reading it off a value would
 * make the same query compile to different SQL row by row, which it cannot do.
 *
 * Chosen by a ternary over two named constants for the reason {@link JoinFlavour} is: the rule that
 * bans `switch` dispatches an open set of *names*, and this is a `boolean` with no room for a third
 * state.
 *
 * `lateral` renders the relation it is handed and may **bound** it first — {@link OneRowLateral}
 * sets its `LIMIT` where {@link CollectedLateral} must not — so each form owns the arity of the
 * lateral it builds, which is the obligation {@link LOOKUP_BLOCKERS} relies on being kept.
 */
interface LookupForm {
  correlate: Correlation;
  lateral: Materialization;
  replaced: Replacement;
}

/**
 * Bounds the lateral to one row, which is what makes a lookup's arity structural.
 *
 * A `LEFT JOIN LATERAL` over an unbounded subselect multiplies the left by however many rows the
 * other key matched, and a lookup replaces a foreign key with *a* document. Without the bound the
 * arity would be a property of the data — every conformance case's key happens to be unique, so
 * nothing there would ever show it.
 */
function OneRowLateral(right: Relation): string {
  right.limit = SINGLE_ROW;
  return `(${Render(right)})`;
}

/**
 * Collects every matching row into one jsonb array, empty rather than NULL.
 *
 * The array form's answer is a list, so the lateral still yields exactly one row and the arity stays
 * structural for {@link OneRowLateral}'s reason. `jsonb_agg` yields NULL over zero rows, which would
 * make a key that matched nothing read as `null` where the contract's own return type promises an
 * array.
 */
function CollectedLateral(right: Relation, context: DecodingContext): string {
  const alias = context.nextAlias();
  const collected = `jsonb_agg(${QualifiedColumn(alias, OUTPUT_COLUMN)})`;
  return (
    `(SELECT COALESCE(${collected}, ${EMPTY_ARRAY})` +
    ` AS ${QuoteIdentifier(OUTPUT_COLUMN)}` +
    ` FROM (${Render(right)}) AS ${QuoteIdentifier(alias)})`
  );
}

const SINGLE_FORM: LookupForm = {
  correlate: (other, local) => `(${other.sql} = ${local.sql})`,
  lateral: OneRowLateral,
  replaced: (value) => value,
};

const COLLECTED_FORM: LookupForm = {
  correlate: (other, local) => `(${local.sql} ${CONTAINS} ${other.sql})`,
  lateral: CollectedLateral,
  replaced: ArrayOf,
};

function FormOf(local: Compiled): LookupForm {
  return local.type.kind === ARRAY_KIND ? COLLECTED_FORM : SINGLE_FORM;
}

/**
 * Compiles the query the key points at, from its own root, and opens it to one more predicate.
 *
 * The argument is read off the stage directly for {@link JoinedRelation}'s reason. It is prepared
 * against {@link WHERE_BLOCKERS} rather than nested, so the correlation absorbs into the right's own
 * `WHERE` and the whole lateral stays one `SELECT` with its `_instance` scope beside it.
 */
function LookedUp(stage: QueryStage, context: DecodingContext): Relation {
  const other = stage.args[FIRST_OPERAND];
  assert(
    other instanceof Query,
    "The 'lookup' stage takes another query to read the key from",
  );
  return Prepare(context.relation(other.build()), WHERE_BLOCKERS, context);
}

/**
 * Pushes the correlation onto the looked-up relation, comparing two declared columns.
 *
 * Both sides go through {@link UnifyOperands}, which is the coercion `eq` itself applies: a bare
 * `=` between a declared `text` column and a jsonb-sourced local key is refused at plan time, so the
 * statement never reads a row (invariant 13). Two columns of one declared kind meet at that kind and
 * take no cast at all, which is what leaves the comparison reachable by a btree index.
 *
 * **A scalar key against a column declared as an array is the mirror of the array form and takes
 * the mirrored operator**, not `=`: unifying an array with a scalar meets at the bottom type, and
 * `<jsonb array> = <jsonb scalar>` is false on every row of every dataset. Containment is also the
 * only comparison a `jsonb_ops` GIN index serves, and it is emitted bare for that reason — a guard
 * around it is one opaque expression no index can be pushed into (invariant 14). The form itself
 * still comes from the *local* key, which is a scalar and therefore still names one row.
 */
function Correlate(
  right: Relation,
  otherKey: string,
  local: Compiled,
  form: LookupForm,
): void {
  const other = right.source.field(otherKey);
  if (IsArray(other.type) && !IsArray(local.type)) {
    right.where.push(`(${other.sql} ${CONTAINS} ${AsJson(local).sql})`);
    return;
  }
  const unified = UnifyOperands(other, local);
  right.where.push(form.correlate(unified.left, unified.right));
}

/**
 * The merge under a container guard, for a left document nothing says is an object.
 *
 * The guard reads the value it protects and that value is a materialized document, so it goes
 * through {@link HeldOnce} rather than `GuardJson` — which is also the shape that would still work
 * if the operator could fail, as `without`'s must. The lateral's alias is a column of the enclosing
 * query, which the derived table's own select list may reference.
 *
 * **`HeldOnce` holds once in the *text*, not once at run time.** The planner pulls the one-row
 * subquery up and substitutes the held expression into both the output and the one-time filter, so
 * the document is built twice per row; measured at +25 % execution against the bare merge. That
 * price is why the guard is emitted on this branch only.
 */
function GuardedMerge(document: string, member: string, alias: string): string {
  return HeldOnce({
    value: document,
    column: HELD_COLUMN,
    alias,
    select: (column) => `${column} || ${member}`,
    guard: (column) =>
      `jsonb_typeof(${column}) = ${QuoteLiteral(OBJECT_TYPEOF)}`,
  });
}

/**
 * The left document with one key overwritten, which is what a lookup answers.
 *
 * `||` overwrites rather than appends, and the document is spelled as a whole rather than rebuilt
 * member by member because a rebuild would need the left's full key list, which a value-mode left
 * does not have. `||` is **total** — `'{"a":1}' || '"x"'` is `[{"a":1},"x"]`, and no combination of
 * scalar, object, array and null raises — so the guard defends type soundness rather than the
 * statement, which is ordinarily what invariant 14 says not to do. It is therefore emitted only
 * where the difference is observable. A left whose type carries no shape keeps it: "replace this
 * key" has no meaning over a value with no keys, and `obj_merge` already answers NULL for exactly
 * this operator on exactly this reading, so dropping it there would make one operator disagree with
 * itself. A shaped left takes the bare merge instead, which is the path every real lookup takes and
 * which {@link GuardedMerge} costs a measured 25 % of execution to leave.
 *
 * **The shape is a test of provenance, not a proof about the value, and one case makes that
 * matter.** A jsonb column declared with members carries a shape while the caller controls what is
 * stored in it, so `map(d => d.key("metadata")).lookup(…)` is shaped over a value that may be a
 * scalar at run time, and answers the two-element array `[scalar, {looked}]` rather than NULL. That
 * is the *surprising answer* invariant 14 declines to defend against, and it cannot fail — the
 * shape does not claim otherwise.
 */
function Replaced(
  document: Compiled,
  key: string,
  value: Compiled,
  context: DecodingContext,
): Compiled {
  const member = `jsonb_build_object(${QuoteLiteral(key)}, ${value.sql})`;
  const left = AsJson(document).sql;
  const shape = ShapeOf(document.type);
  return {
    sql: shape
      ? `(${left} || ${member})`
      : GuardedMerge(left, member, context.nextAlias()),
    type: MergeShapes(document.type, JsonOf({ [key]: value.type })),
  };
}

/**
 * Replaces one key of each row with the row it points at, through a `LEFT JOIN LATERAL`.
 *
 * One handler serves `table.lookup(…)` and `table.get(k).lookup(…)`, which the contract records as
 * the same stage from two builders. The shape is decided before anything is decoded (ground rule 1):
 * the array-ness of the local key is read off its declared type, so a handler that compiled the
 * correlation and then changed its mind about the operator would have bound a `$n` no fragment
 * references.
 *
 * **`single` and the value beside it survive because nothing here touches them**, and that is a
 * property of this shape rather than a line of code: the relation is neither re-seeded nor wrapped
 * on the common path, which is what lets `get(k).lookup(…)` still answer one document rather than a
 * list of one. A refactor that re-seeded through `ValueRelation` would lose it silently.
 */
const LookupStage: PipelineStage = (relation, stage, context) => {
  const keys = KeysOf(stage);
  const prepared = Prepare(relation, LOOKUP_BLOCKERS, context);
  const local = prepared.source.field(keys.localKey);
  const form = FormOf(local);
  const right = LookedUp(stage, context);
  Correlate(right, keys.otherKey, local, form);
  const answer = CurrentValue(right);
  const from = form.lateral(SetProjection(right, answer), context);
  const alias = context.nextAlias();
  prepared.joins.push({
    kind: LATERAL_KIND,
    from,
    alias,
    on: UNCONDITIONAL,
  });
  const looked: Compiled = {
    sql: QualifiedColumn(alias, OUTPUT_COLUMN),
    type: form.replaced(answer.type),
  };
  return SetProjection(
    prepared,
    Replaced(CurrentValue(prepared), keys.localKey, looked, context),
  );
};

/** The stages that bring a second query into the pipeline beside the one it is folding. */
export const JOIN_STAGES: PipelineStageMap = {
  join: JoinStage,
  lookup: LookupStage,
};
