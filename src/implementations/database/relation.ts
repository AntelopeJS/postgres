import assert from "node:assert";

import type { SqlType } from "./types";
import { type Compiled, QualifiedColumn } from "./sql";
import type { TableModel } from "./fields";
import {
  AliasedColumns,
  ColumnRowSource,
  type DocumentMember,
  type ExternalReads,
  ExternalRowSource,
  JsonRowSource,
  LoggedColumns,
  type RowSource,
} from "./row-source";

/** The single column a value-mode relation projects, and the key its rows are decoded from. */
export const OUTPUT_COLUMN = "value";

type IndexResolver = (name: string) => string[];
type ScanNotice = (name: string) => void;

/**
 * What the relation still knows about the table it reads.
 *
 * Present only while the pipeline is row-shaped: a stage that reshapes the output drops it, and
 * its absence is what makes a later write illegal rather than a flag somebody has to check.
 */
export interface TableOrigin {
  schemaId: string;
  tableId: string;
  model: TableModel;
  index: IndexResolver;
  /** Told when a `CROSS_INSTANCE` read scans by an index name; absent where nobody is listening. */
  crossInstanceScan?: ScanNotice;
}

export interface OrderTerm {
  sql: string;
  descending: boolean;
}

/**
 * What a single-row relation answers with when it read no row.
 *
 * `null` everywhere but `get`, which the contract asserts answers `undefined` for a row that is
 * not there. It is a value the relation carries rather than an optional field holding the answer,
 * because an optional field set to `undefined` cannot be told apart from one that was never set.
 */
type AbsentValue = null | undefined;

/**
 * The join keywords {@link RenderJoin}'s template can spell, which is what makes it total.
 *
 * The template hard-requires both an ` AS <alias>` and an ` ON <on>`, so a `"CROSS JOIN"` would
 * typecheck under a bare `string` and emit unparseable SQL. Only the legal set lives here; which
 * one a stage emits is `stages-join.ts`'s to decide, so the renderer and the vocabulary it can
 * spell cannot drift apart.
 */
export type JoinKind = "JOIN" | "LEFT JOIN" | "LEFT JOIN LATERAL";

/**
 * One `JOIN` the relation carries, rendered between its `FROM` and its `WHERE`.
 *
 * `kind` is the whole join keyword and `from` is already-rendered FROM text for the same reason
 * {@link Relation.from} is, so a joined table and a joined subselect share one spelling.
 *
 * `on` is a complete boolean fragment: a parenthesised condition where a condition is what the
 * join needs, and the bare literal `true` for a lateral that answers at most one row and carries
 * its correlation inside the subselect instead. {@link Relation.where}'s rule is about fragments
 * that later get composed and an `ON` is composed with nothing, so the parentheses are the obligation of
 * whoever built the condition rather than of this field — `"(true)"` would be cargo.
 */
export interface JoinClause {
  kind: JoinKind;
  from: string;
  alias: string;
  on: string;
}

/**
 * An unrendered `SELECT`, and the accumulator the pipeline folds over.
 *
 * `from` is already-rendered FROM text — a qualified table, a parenthesised subselect or a
 * union — so the three cases share one spelling, with `alias` always emitted. `projection`
 * discriminates the two output modes: absent selects the physical columns and decodes rows,
 * present selects one {@link OUTPUT_COLUMN} and decodes values.
 *
 * `crossInstance` is the root's instance scope reduced to the one fact a stage can act on: whether
 * `_id` alone still names one row. It rides here rather than on the context because a nested query
 * has its own root and its own scope, and it is false on a nested relation for the same reason
 * `origin` is absent from one — both are facts about the physical table a relation still reads.
 *
 * `groupBy` holds compiled terms rather than text because the same {@link Compiled} is also the
 * group value in the select list, and a second resolution of the same field is free to differ — a
 * default, a cast — which PostgreSQL then rejects with `42803` naming a column that is visibly in
 * the `GROUP BY`.
 */
export interface Relation {
  from: string;
  alias: string;
  joins: JoinClause[];
  /**
   * The conjuncts of the `WHERE`, **each one already parenthesised by whoever pushed it**.
   *
   * They are joined with `AND`, so a fragment that arrives spelling a bare disjunction rebinds
   * across every other conjunct and answers a different question with nothing failing. `Predicate`
   * over a `bool` operand is the identity, so nothing downstream adds the parentheses on a stage's
   * behalf: the obligation belongs to the stage that pushes, and it is why `filter`, the three
   * selection stages and the write target each wrap their own condition.
   */
  where: string[];
  groupBy: Compiled[];
  orderBy: OrderTerm[];
  limit?: string;
  offset?: string;
  distinct: boolean;
  single: boolean;
  absent: AbsentValue;
  aggregated: boolean;
  crossInstance: boolean;
  source: RowSource;
  projection?: Compiled;
  origin?: TableOrigin;
  /** The source a plain projection renamed — see {@link SetPlainProjection}. */
  projectedFrom?: RowSource;
}

type RelationSeed = Pick<
  Relation,
  "from" | "alias" | "source" | "projection" | "origin"
>;

function NewRelation(seed: RelationSeed): Relation {
  return {
    ...seed,
    joins: [],
    where: [],
    groupBy: [],
    orderBy: [],
    distinct: false,
    single: false,
    absent: null,
    aggregated: false,
    crossInstance: false,
  };
}

/** The table a row-mode relation reads, for the select list and the decoder that pair with it. */
export function RequireOrigin(relation: Relation): TableOrigin {
  const origin = relation.origin;
  assert(origin, "A row-mode relation must carry the origin of its table");
  return origin;
}

/**
 * The columns an index name addresses, in the order the index declares them.
 *
 * `orderBy`, `getAll`, `between` and `group` all name an index the same way and must expand it the
 * same way: a second expansion would sort by one field list and match against another, and the
 * btree scan would quietly stop being served with nothing failing. A relation that no longer knows
 * its table can only read the name as a field, which is what keeps `map(…).orderBy("age")` working.
 *
 * Each column keeps the field it was expanded from, because a compound index is also a *document*
 * to a `group`'s mapper and its member names are the index's own. Reading them beside the columns
 * rather than beside the caller is what keeps that one expansion rather than two.
 */
export function IndexColumns(
  relation: Relation,
  name: string,
): DocumentMember[] {
  const fields = relation.origin ? relation.origin.index(name) : [name];
  return fields.map((field) => ({
    name: field,
    ...relation.source.field(field),
  }));
}

/**
 * {@link IndexColumns} for the stages that scan by the index — `getAll`, `between` and `orderBy` —
 * which is what a table's origin hears about when the read spans every instance.
 */
export function ScanColumns(
  relation: Relation,
  name: string,
): DocumentMember[] {
  if (relation.crossInstance) {
    relation.origin?.crossInstanceScan?.(name);
  }
  return IndexColumns(relation, name);
}

function TableSource(
  alias: string,
  origin: TableOrigin,
  reads: ExternalReads,
): RowSource {
  if (origin.model.external) {
    return new ExternalRowSource(alias, origin.model, reads);
  }
  return new ColumnRowSource(AliasedColumns(alias), origin.model);
}

/**
 * A row-mode relation over a table, or over a subselect that selected one's rows.
 *
 * `reads` matters only for an external relation, whose subselect already holds every value under
 * its field name rather than the native column a table read converts; a table the adapter owns
 * keeps its physical names through a subselect, so it reads both alike.
 */
export function TableRelation(
  from: string,
  alias: string,
  origin: TableOrigin,
  reads: ExternalReads = "table",
): Relation {
  return NewRelation({
    from,
    alias,
    source: TableSource(alias, origin, reads),
    origin,
  });
}

/**
 * A relation over one **logged** row — a physical row the change log stored whole in jsonb.
 *
 * The same `ColumnRowSource` a table relation reads through, differing only in how it addresses a
 * column, which is the whole of what makes a feed's document equal a read's **by construction**
 * rather than by test. Two independent assemblers would agree on a five-field vehicle and drift on
 * `_extra`, on a null in a declared column, on a truncated identifier, or on a field added after
 * the row was logged — none of which any conformance case touches.
 *
 * It carries the table's real origin, so `getAll` and `between` expand an index name through the
 * one expansion the DDL and the read path already share.
 */
export function LoggedRelation(
  from: string,
  alias: string,
  row: string,
  origin: TableOrigin,
): Relation {
  return NewRelation({
    from,
    alias,
    source: new ColumnRowSource(LoggedColumns(row), origin.model),
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
  relation.projectedFrom = undefined;
  return relation;
}

/**
 * Projects, and keeps the source addressable: only for a projection that *renames* its members, so
 * that the columns underneath still answer for them. Every other {@link SetProjection} clears it.
 */
export function SetPlainProjection(
  relation: Relation,
  value: Compiled,
  source: RowSource,
): Relation {
  const projected = SetProjection(relation, value);
  projected.projectedFrom = source;
  return projected;
}

/** What the relation currently yields, materialized — the operand of a field-less stage. */
export function CurrentValue(relation: Relation): Compiled {
  return relation.projection ?? relation.source.toJson();
}
