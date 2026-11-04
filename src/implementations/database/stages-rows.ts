import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { OptionsOf } from "./utils";

import type { Compiled } from "./sql";
import { Cast, Widen } from "./coerce";
import type { SqlType } from "./types";
import type { DecodingContext } from "./context";
import { DecodeFunction, DecodeValue, RecordedLambda } from "./value";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { ClampToRange, INT4_MAX, Numeric, Predicate } from "./readings";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import {
  CurrentValue,
  ScanColumns,
  type OrderTerm,
  type Relation,
  SetProjection,
  ValueRelation,
} from "./relation";
import {
  Prepare,
  type RelationFlag,
  Render,
  RowBound,
  SINGLE_ROW,
  WHERE_BLOCKERS,
} from "./render";
import { IsString } from "./guards";
import { ClassifyMember } from "./member";

/**
 * An `ORDER BY` runs before the row bounds, so those and an aggregate are what block it.
 * `distinct` is absent because it cannot be reached from here.
 */
const ORDER_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "aggregated",
];

/**
 * A row bound composes with nothing that is already bounding rows, and reads no field.
 * `projection` is absent, which is what keeps `map(…).slice(0, 2)` a single `SELECT`.
 */
const BOUND_BLOCKERS: readonly RelationFlag[] = [
  "limit",
  "offset",
  "aggregated",
];

const DESCENDING = "desc";

const LOWEST_BOUND = 0;
const HIGHEST_BOUND = INT4_MAX;

/**
 * Bounds a row count above as well as below, and keeps an unreadable one unreadable.
 * The ceiling is `integer`'s, and the NULL guard is what stops a bound becoming `LIMIT 0`.
 */
function ClampBound(sql: string): string {
  const clamped = ClampToRange(sql, LOWEST_BOUND, HIGHEST_BOUND);
  return `CASE WHEN ${sql} IS NOT NULL THEN ${clamped} END`;
}

/**
 * Reads a caller-supplied row bound as the `bigint` `LIMIT` and `OFFSET` take.
 * Cast explicitly through {@link ClampBound}, which is what keeps the cast itself total.
 */
function Bound(
  stage: QueryStage,
  index: number,
  context: DecodingContext,
): string {
  const compiled = DecodeValue(ClassifyMember(stage.args[index]), context);
  const bound = RequireOperand(compiled, stage, index);
  return RowBound(ClampBound(Numeric(bound).sql));
}

/**
 * Binds the predicate to the relation's own source rather than to a materialized document, which
 * is what keeps `filter((doc) => doc.key("age").gt(25))` reading a btree-indexed column.
 */
const FilterStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, WHERE_BLOCKERS, context);
  const body = DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
    prepared.source,
  ]);
  const predicate = RequireOperand(body, stage, FIRST_OPERAND);
  prepared.where.push(`(${Predicate(predicate).sql})`);
  return prepared;
};

function SortName(stage: QueryStage): string {
  const name: unknown = OptionsOf(stage)?.index;
  assert(
    IsString(name),
    "The 'orderBy' stage is missing the index or field to sort on",
  );
  return name;
}

/**
 * Prepends the sort terms, so a later `orderBy` dominates an earlier one, as stable sorts compose.
 * No null ordering is spelled: naming one turns an index range scan into a sort.
 */
const OrderByStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, ORDER_BLOCKERS, context);
  const descending = OptionsOf(stage)?.direction === DESCENDING;
  const terms = ScanColumns(prepared, SortName(stage)).flatMap(
    (column): OrderTerm[] =>
      (column.native?.order ?? [column.sql]).map((sql) => ({
        sql,
        descending,
      })),
  );
  prepared.orderBy.unshift(...terms);
  return prepared;
};

const SliceStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, BOUND_BLOCKERS, context);
  prepared.offset = Bound(stage, FIRST_OPERAND, context);
  if (stage.args[SECOND_OPERAND] !== undefined) {
    prepared.limit = Bound(stage, SECOND_OPERAND, context);
  }
  return prepared;
};

const NthStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, BOUND_BLOCKERS, context);
  prepared.offset = Bound(stage, FIRST_OPERAND, context);
  prepared.limit = SINGLE_ROW;
  prepared.single = true;
  return prepared;
};

const CONCATENATION = "UNION ALL";

interface UnionSide {
  relation: Relation;
  value: Compiled;
}

function Sided(relation: Relation): UnionSide {
  return { relation, value: CurrentValue(relation) };
}

/**
 * Renders one side of a union as a single-column `SELECT` of the type both sides meet at.
 * `UNION ALL` matches its branches by physical type, so each side is cast to the union's own.
 */
function Materialize(side: UnionSide, type: SqlType): string {
  return Render(SetProjection(side.relation, Cast(side.value, type)));
}

/**
 * Compiles the query the union concatenates, from its own `schema`/`instance`/`table` root.
 * Read off the stage and compiled through the same context, whose fold it asks for rather imports.
 */
function Concatenated(stage: QueryStage, context: DecodingContext): Relation {
  const other: unknown = stage.args[FIRST_OPERAND];
  assert(
    other instanceof Query,
    "The 'union' stage takes another query to concatenate",
  );
  return context.relation(other.build());
}

/**
 * Concatenates two streams, keeping every row of both, as an ordinary value-mode relation.
 * The type is the {@link Widen} of the two sides, since each row carries only its own side's keys.
 */
const UnionStage: PipelineStage = (relation, stage, context) => {
  const left = Sided(relation);
  const right = Sided(Concatenated(stage, context));
  const type = Widen(left.value.type, right.value.type);
  return ValueRelation(
    `((${Materialize(left, type)}) ${CONCATENATION} (${Materialize(right, type)}))`,
    context.nextAlias(),
    type,
  );
};

/** The stages that select and order rows without reshaping what the relation yields. */
export const ROW_STAGES: PipelineStageMap = {
  filter: FilterStage,
  orderBy: OrderByStage,
  slice: SliceStage,
  nth: NthStage,
  union: UnionStage,
};
