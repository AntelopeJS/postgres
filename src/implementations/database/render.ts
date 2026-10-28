import assert from "node:assert";

import type { DecodingContext } from "./context";
import { EXTRA_COLUMN, ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import { QualifiedColumn, QuoteIdentifier } from "./sql";
import { DeclaredColumns, PhysicalOrder, type TableModel } from "./fields";
import { ExternalNames } from "./row-source";
import {
  type JoinClause,
  OUTPUT_COLUMN,
  type Relation,
  RequireOrigin,
  TableRelation,
  ValueRelation,
} from "./relation";

/** An external relation's select list: each member read as its value, under its own name. */
function ExternalColumns(relation: Relation, model: TableModel): string[] {
  return ExternalNames(model).map(
    (name) => `${relation.source.field(name).sql} AS ${QuoteIdentifier(name)}`,
  );
}

function RowColumns(relation: Relation): string[] {
  const origin = RequireOrigin(relation);
  if (origin.model.external) {
    return ExternalColumns(relation, origin.model);
  }
  const declared = DeclaredColumns(origin.model);
  const columns = PhysicalOrder(
    ID_COLUMN,
    INSTANCE_COLUMN,
    declared,
    EXTRA_COLUMN,
  );
  return columns.map((column) => QualifiedColumn(relation.alias, column));
}

function SelectList(relation: Relation): string {
  const projection = relation.projection;
  if (!projection) {
    return RowColumns(relation).join(", ");
  }
  return `${projection.sql} AS ${QuoteIdentifier(OUTPUT_COLUMN)}`;
}

type ClauseBuilder = (relation: Relation) => string | undefined;

function SelectClause(relation: Relation): string {
  const modifier = relation.distinct ? "DISTINCT " : "";
  return `SELECT ${modifier}${SelectList(relation)}`;
}

function FromItem(from: string, alias: string): string {
  return `${from} AS ${QuoteIdentifier(alias)}`;
}

function FromClause(relation: Relation): string {
  return `FROM ${FromItem(relation.from, relation.alias)}`;
}

function RenderJoin(join: JoinClause): string {
  return `${join.kind} ${FromItem(join.from, join.alias)} ON ${join.on}`;
}

function JoinClauses(relation: Relation): string | undefined {
  if (relation.joins.length === 0) {
    return undefined;
  }
  return relation.joins.map(RenderJoin).join(" ");
}

function WhereClause(relation: Relation): string | undefined {
  if (relation.where.length === 0) {
    return undefined;
  }
  return `WHERE ${relation.where.join(" AND ")}`;
}

function GroupByClause(relation: Relation): string | undefined {
  if (relation.groupBy.length === 0) {
    return undefined;
  }
  return `GROUP BY ${relation.groupBy.map((term) => term.sql).join(", ")}`;
}

function OrderTerms(relation: Relation): string | undefined {
  if (relation.orderBy.length === 0) {
    return undefined;
  }
  const terms = relation.orderBy.map(
    (term) => `${term.sql} ${term.descending ? "DESC" : "ASC"}`,
  );
  return terms.join(", ");
}

function OrderByClause(relation: Relation): string | undefined {
  const terms = OrderTerms(relation);
  return terms === undefined ? undefined : `ORDER BY ${terms}`;
}

const BOUND_PARAMETER = /\$\d/;

/**
 * Takes the order terms off the relation, spelled exactly as the clause spells them.
 *
 * The one door for a stage that absorbs an aggregate, which each of the two do for a
 * different reason and with a different answer: a stream aggregate discards the terms outright,
 * since no ordering can change what it reduces to, while a subquery's aggregate re-emits them
 * inside `jsonb_agg(… ORDER BY …)`, where they are the whole of what makes the array's order a
 * promise rather than an observation.
 *
 * **The refusal asserts that an order term carries no `$n`, rather than assuming it.** Absorbing is
 * the one place this pipeline discards compiled text, and a discarded term holding a `$n` leaves
 * the statement binding a parameter no fragment references — `bind message supplies N parameters,
 * but prepared statement requires M`, naming nothing about the query. It holds today because
 * `orderBy` builds its terms from `source.field(name)` with no default and therefore decodes
 * nothing; an `orderBy` that ever decoded an argument has to render its terms into a subselect
 * instead, and this says so where the edit lands rather than in a comment nobody reads.
 */
export function AbsorbOrder(relation: Relation): string | undefined {
  const terms = OrderTerms(relation);
  assert(
    terms === undefined || !BOUND_PARAMETER.test(terms),
    "An order term must carry no bound parameter, since absorbing an aggregate discards it",
  );
  relation.orderBy = [];
  return terms;
}

const ONE_ROW = "1";

/**
 * Reads a row bound as the `bigint` {@link LimitClause} and {@link OffsetClause} take.
 *
 * The one owner of that cast, because it is this clause's business rather than any
 * one stage's: a decoded number is `double precision`, whose assignment cast is not guaranteed in
 * this position. Making the fragment total against a caller's number is the caller's half — the
 * clamp lives with the stage that decodes one.
 */
export function RowBound(sql: string): string {
  return `((${sql})::bigint)`;
}

/**
 * The bound that makes a relation answer at most one row, spelled once for all its callers.
 *
 * `nth` takes it because the contract asks for one row, and `lookup`'s lateral takes it because a
 * lateral answering more than one row would multiply the left side it was given. A second spelling
 * would be free to drift from this one — a bound that stopped clamping, or that stopped casting to
 * the type `LIMIT` takes — with nothing failing.
 */
export const SINGLE_ROW = RowBound(ONE_ROW);

function LimitClause(relation: Relation): string | undefined {
  return relation.limit === undefined ? undefined : `LIMIT ${relation.limit}`;
}

function OffsetClause(relation: Relation): string | undefined {
  return relation.offset === undefined
    ? undefined
    : `OFFSET ${relation.offset}`;
}

const CLAUSES: ClauseBuilder[] = [
  SelectClause,
  FromClause,
  JoinClauses,
  WhereClause,
  GroupByClause,
  OrderByClause,
  LimitClause,
  OffsetClause,
];

export function Render(relation: Relation): string {
  const clauses = CLAUSES.map((build) => build(relation));
  return clauses.filter((clause) => clause !== undefined).join(" ");
}

/**
 * Renders the relation into a subselect and starts a fresh one over it, addressing its output at a
 * new alias.
 *
 * {@link Prepare} is the only door to a *conditional* wrap — the one a stage takes because a flag
 * blocks it. `Nested` is the door for a relation that is *becoming a FROM item of another
 * relation*, where the wrap is unconditional and the caller is not continuing the relation it
 * wrapped. The rule that mattered is untouched: a relation is still rendered exactly once, and
 * `Nested` is still the only thing that renders one into a subselect.
 *
 * The inner text is produced **once** and stored, so a fragment that took a guard emitting its
 * operand twice is paid for once per wrap level instead of compounding down the chain — the same
 * argument that makes a projection block another projection.
 *
 * Row mode survives, because the rendered select list preserves the physical column names, which
 * is what keeps a filter after a slice reading a btree-indexed column. `single` and the
 * {@link AbsentValue} beside it carry through; `aggregated` does not, since the wrapping relation
 * is not itself an aggregate, and the remaining clauses — {@link Relation.joins} among them — are
 * already expressed in the rendered text.
 */
export function Nested(relation: Relation, context: DecodingContext): Relation {
  const from = `(${Render(relation)})`;
  const alias = context.nextAlias();
  const projection = relation.projection;
  const wrapped = projection
    ? ValueRelation(from, alias, projection.type)
    : TableRelation(from, alias, RequireOrigin(relation), "output");
  wrapped.single = relation.single;
  wrapped.absent = relation.absent;
  return wrapped;
}

export type RelationFlag =
  | "projection"
  | "limit"
  | "offset"
  | "distinct"
  | "ordered"
  | "aggregated";

/**
 * The flags that block absorbing a predicate into `WHERE`, which is the relation's own clause order.
 *
 * A `WHERE` runs before the clauses that choose rows and cannot mention an aggregate at all.
 * Absorbing past a limit, an offset or a `DISTINCT` would filter the rows the relation had *before*
 * those clauses picked from them — `slice(0, 2).filter(…)` would test the whole table and then take
 * two — and absorbing past an aggregate raises
 * `42803 aggregate functions are not allowed in WHERE`. A pending projection blocks it for the same
 * reason it blocks every stage that resolves a field.
 *
 * Stated here rather than in the family that first needed it: every stage pushing onto
 * {@link Relation.where} blocks on exactly these, and a second copy of the list would be free to
 * drift from this one with nothing failing.
 */
export const WHERE_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

type RelationPredicate = (relation: Relation) => boolean;

const FLAG_PREDICATES: Record<RelationFlag, RelationPredicate> = {
  projection: (relation) => relation.projection !== undefined,
  limit: (relation) => relation.limit !== undefined,
  offset: (relation) => relation.offset !== undefined,
  distinct: (relation) => relation.distinct,
  ordered: (relation) => relation.orderBy.length > 0,
  aggregated: (relation) => relation.aggregated,
};

/**
 * The one place a *conditional* wrap is decided: every stage continuing its own relation opens by
 * naming the flags that block it, and reaches {@link Nested} through nothing else.
 *
 * What a wrap preserves and what it drops is stated on {@link Nested}, which is also the door a
 * relation becoming a FROM item of another relation takes directly.
 */
export function Prepare(
  relation: Relation,
  blockedBy: readonly RelationFlag[],
  context: DecodingContext,
): Relation {
  const blocked = blockedBy.some((flag) => FLAG_PREDICATES[flag](relation));
  return blocked ? Nested(relation, context) : relation;
}

/** Whether any of the named flags is raised on the relation. */
export function HasFlag(
  relation: Relation,
  flags: readonly RelationFlag[],
): boolean {
  return flags.some((flag) => FLAG_PREDICATES[flag](relation));
}
