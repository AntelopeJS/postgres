import assert from "node:assert";
import type { DecodingContext } from "./context";
import type { TableShape } from "./fields";
import { ColumnRowSource, JsonRowSource, type RowSource } from "./row-source";
import { type Compiled, QualifiedColumn, QuoteIdentifier } from "./sql";
import type { SqlType } from "./types";
import { EXTRA_COLUMN, ID_COLUMN, INSTANCE_COLUMN } from "./utils";

/** The single column a value-mode relation projects, and the key its rows are decoded from. */
export const OUTPUT_COLUMN = "value";

export type IndexResolver = (name: string) => string[];

/**
 * What the relation still knows about the table it reads.
 *
 * Present only while the pipeline is row-shaped: a stage that reshapes the output drops it, and
 * its absence is what makes a later write illegal rather than a flag somebody has to check.
 */
export interface TableOrigin {
  schemaId: string;
  tableId: string;
  shape: TableShape;
  index: IndexResolver;
}

export interface OrderTerm {
  sql: string;
  descending: boolean;
}

/**
 * An unrendered `SELECT`, and the accumulator the pipeline folds over.
 *
 * `from` is already-rendered FROM text — a qualified table, a parenthesised subselect or a
 * union — so the three cases share one spelling, with `alias` always emitted. `projection`
 * discriminates the two output modes: absent selects the physical columns and decodes rows,
 * present selects one {@link OUTPUT_COLUMN} and decodes values.
 */
export interface Relation {
  from: string;
  alias: string;
  where: string[];
  orderBy: OrderTerm[];
  limit?: string;
  offset?: string;
  distinct: boolean;
  single: boolean;
  aggregated: boolean;
  source: RowSource;
  projection?: Compiled;
  origin?: TableOrigin;
}

type RelationSeed = Pick<
  Relation,
  "from" | "alias" | "source" | "projection" | "origin"
>;

function NewRelation(seed: RelationSeed): Relation {
  return {
    ...seed,
    where: [],
    orderBy: [],
    distinct: false,
    single: false,
    aggregated: false,
  };
}

/** The table a row-mode relation reads, for the select list and the decoder that pair with it. */
export function RequireOrigin(relation: Relation): TableOrigin {
  const origin = relation.origin;
  assert(origin, "A row-mode relation must carry the origin of its table");
  return origin;
}

function RowColumns(relation: Relation): string[] {
  const origin = RequireOrigin(relation);
  const declared = Object.values(origin.shape.fields).map(
    (spec) => spec.column,
  );
  const columns = [ID_COLUMN, INSTANCE_COLUMN, ...declared, EXTRA_COLUMN];
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

function FromClause(relation: Relation): string {
  return `FROM ${relation.from} AS ${QuoteIdentifier(relation.alias)}`;
}

function WhereClause(relation: Relation): string | undefined {
  if (relation.where.length === 0) {
    return undefined;
  }
  return `WHERE ${relation.where.join(" AND ")}`;
}

function OrderByClause(relation: Relation): string | undefined {
  if (relation.orderBy.length === 0) {
    return undefined;
  }
  const terms = relation.orderBy.map(
    (term) => `${term.sql} ${term.descending ? "DESC" : "ASC"}`,
  );
  return `ORDER BY ${terms.join(", ")}`;
}

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
  WhereClause,
  OrderByClause,
  LimitClause,
  OffsetClause,
];

export function Render(relation: Relation): string {
  const clauses = CLAUSES.map((build) => build(relation));
  return clauses.filter((clause) => clause !== undefined).join(" ");
}

export function TableRelation(
  from: string,
  alias: string,
  origin: TableOrigin,
): Relation {
  return NewRelation({
    from,
    alias,
    source: new ColumnRowSource(alias, origin.shape),
    origin,
  });
}

/**
 * A value-mode relation over already-rendered FROM text whose single output column is
 * {@link OUTPUT_COLUMN} — what a wrapped projection and a union both produce.
 */
export function ValueRelation(
  from: string,
  alias: string,
  type: SqlType,
): Relation {
  const projection: Compiled = {
    sql: QualifiedColumn(alias, OUTPUT_COLUMN),
    type,
  };
  return NewRelation({
    from,
    alias,
    source: new JsonRowSource(projection),
    projection,
  });
}

function Wrap(relation: Relation, context: DecodingContext): Relation {
  const from = `(${Render(relation)})`;
  const alias = context.nextAlias();
  const projection = relation.projection;
  const wrapped = projection
    ? ValueRelation(from, alias, projection.type)
    : TableRelation(from, alias, RequireOrigin(relation));
  wrapped.single = relation.single;
  return wrapped;
}

export type RelationFlag =
  | "projection"
  | "limit"
  | "offset"
  | "distinct"
  | "ordered"
  | "aggregated";

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
 * The one place a wrap is decided: every stage opens by naming the flags that block it, and
 * wrapping is reachable through nothing else.
 *
 * A blocked stage renders the relation into a subselect and starts a fresh one over it. The
 * inner text is produced **once** and stored, so a fragment that took a guard emitting its
 * operand twice is paid for once per wrap level instead of compounding down the chain — the
 * same argument that makes a projection block another projection.
 *
 * Row mode survives a wrap because the rendered select list preserves the physical column names,
 * which is what keeps a filter after a slice reading a btree-indexed column. `single` carries
 * through; `aggregated` does not, since the wrapping relation is not itself an aggregate, and
 * the remaining clauses are already expressed in the rendered text.
 */
export function Prepare(
  relation: Relation,
  blockedBy: readonly RelationFlag[],
  context: DecodingContext,
): Relation {
  const blocked = blockedBy.some((flag) => FLAG_PREDICATES[flag](relation));
  return blocked ? Wrap(relation, context) : relation;
}

/**
 * Moves the relation into value mode, addressing the projection for every later stage.
 *
 * Deliberately does not wrap — the caller has already called {@link Prepare}, which is what
 * keeps the wrap decision in one place.
 */
export function SetProjection(relation: Relation, value: Compiled): Relation {
  relation.projection = value;
  relation.source = new JsonRowSource(value);
  relation.origin = undefined;
  return relation;
}

/** What the relation currently yields, materialized — the operand of a field-less stage. */
export function CurrentValue(relation: Relation): Compiled {
  return relation.projection ?? relation.source.toJson();
}
