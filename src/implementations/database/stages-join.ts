import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { EMPTY_ARRAY } from "./jsonb";
import { UnifyOperands } from "./coerce";
import { DecodeFunction } from "./value";
import { AsJson, Predicate } from "./readings";
import type { DecodingContext } from "./context";
import { NullableRowSource, type RowSource } from "./row-source";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import {
  type Compiled,
  QualifiedColumn,
  QuoteIdentifier,
  QuoteLiteral,
} from "./sql";
import {
  ArrayOf,
  IsArray,
  IsOpaque,
  JsonOf,
  MergeKeyTypes,
  type SqlType,
} from "./types";
import {
  CurrentValue,
  HasFlag,
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

const MAPPER_OPERAND = 2;

/**
 * Everything that has already decided *which rows* there are blocks a join, which changes their count.
 * `ordered` deliberately does not: the key is respected, and wrapping would only weaken that.
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
 * `nullable` says whether the mapper's right parameter can be a row that is not there.
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
 * Compiles the query being joined, from its own root, as a FROM item at a fresh alias.
 * Read off the stage directly, and nested unconditionally since nothing the right carries splices.
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
 * The source the mapper reads the right row through, wrapped only where a missed row is possible.
 * A value-mode right needs no wrapper: its projected column is genuinely NULL on a miss.
 */
function MapperSource(right: Relation, flavour: JoinFlavour): RowSource {
  if (!flavour.nullable || !right.origin) {
    return right.source;
  }
  return new NullableRowSource(right.source);
}

/**
 * Brings a second query into the pipeline as a `JOIN`, with the mapper's result as the projection.
 * The shape is decided before anything is decoded, and leaving row mode drops the origin.
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
 * That is safe only while the lateral answers exactly one row, which is this module's obligation.
 */
const LOOKUP_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "distinct",
  "aggregated",
];

const LATERAL_KIND: JoinKind = "LEFT JOIN LATERAL";

/**
 * The whole `ON` of the lateral, which carries no condition of its own.
 * The correlation lives inside the subselect, pushed onto the right's own {@link Relation.where}.
 */
const UNCONDITIONAL = "true";

const CONTAINS = "@>";
const ARRAY_KIND: SqlType["kind"] = "array";

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
 * A key with no declared type is refused rather than assumed scalar, which would drop a stored array.
 */
interface LookupForm {
  correlate: Correlation;
  lateral: Materialization;
  replaced: Replacement;
}

/**
 * Bounds the lateral to one row, which is what makes a lookup's arity structural.
 * Unbounded, it would multiply the left by whatever the other key matched — a property of the data.
 */
function OneRowLateral(right: Relation): string {
  right.limit = SINGLE_ROW;
  return `(${Render(right)})`;
}

/**
 * Collects every matching row into one jsonb array, empty rather than NULL.
 * The lateral still yields one row, and `jsonb_agg` over zero rows would answer `null`, not `[]`.
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

function FormOf(local: Compiled, key: string): LookupForm {
  assert(
    !IsOpaque(local.type),
    `The 'lookup' stage takes its form from the local key's declared type, and '${key}' has none;` +
      ` declare it on the table, as an array to look up a list and as anything else for one row`,
  );
  return local.type.kind === ARRAY_KIND ? COLLECTED_FORM : SINGLE_FORM;
}

/**
 * Compiles the query the key points at, from its own root, and opens it to one more predicate.
 * Prepared rather than nested, so the correlation absorbs and the lateral stays one `SELECT`.
 */
function LookedUp(stage: QueryStage, context: DecodingContext): Relation {
  const other = stage.args[FIRST_OPERAND];
  assert(
    other instanceof Query,
    "The 'lookup' stage takes another query to read the key from",
  );
  return context.relation(other.build());
}

/**
 * {@link WHERE_BLOCKERS} without the projection, which a plain one survives: its columns are still
 * addressable, and the correlation is emitted before the projection applies. The rest chose rows.
 */
const PUSHDOWN_BLOCKERS: readonly RelationFlag[] = WHERE_BLOCKERS.filter(
  (flag) => flag !== "projection",
);

/**
 * Pushes the correlation onto the looked-up relation, comparing two declared columns.
 * Two columns of one kind take no cast; a scalar key against an array column takes containment.
 */
function Correlate(
  right: Relation,
  source: RowSource,
  otherKey: string,
  local: Compiled,
  form: LookupForm,
): void {
  const other = source.field(otherKey);
  if (IsArray(other.type) && !IsArray(local.type)) {
    right.where.push(`(${other.sql} ${CONTAINS} ${AsJson(local).sql})`);
    return;
  }
  const unified = UnifyOperands(other, local);
  right.where.push(form.correlate(unified.left, unified.right));
}

/**
 * The source {@link Correlate} may push onto, or nothing when it has to sit above the projection.
 * Reaching the base column is what keeps the other key on an index.
 */
function Correlatable(right: Relation): RowSource | undefined {
  return HasFlag(right, PUSHDOWN_BLOCKERS) ? undefined : right.projectedFrom;
}

/**
 * The left document with one key overwritten, which is what a lookup answers.
 * `||` overwrites and is total over every json type, so it is emitted bare with nothing defending it.
 */
function Replaced(document: Compiled, key: string, value: Compiled): Compiled {
  const member = `jsonb_build_object(${QuoteLiteral(key)}, ${value.sql})`;
  return {
    sql: `(${AsJson(document).sql} || ${member})`,
    type: MergeKeyTypes(document.type, JsonOf({ [key]: value.type })),
  };
}

/**
 * Replaces one key of each row with the row it points at, through a `LEFT JOIN LATERAL`.
 * `single` survives because the relation is neither re-seeded nor wrapped on the common path.
 */
const LookupStage: PipelineStage = (relation, stage, context) => {
  const keys = KeysOf(stage);
  const prepared = Prepare(relation, LOOKUP_BLOCKERS, context);
  const local = prepared.source.field(keys.localKey);
  const form = FormOf(local, keys.localKey);
  const other = LookedUp(stage, context);
  const under = Correlatable(other);
  if (under) {
    Correlate(other, under, keys.otherKey, local, form);
  }
  const right = Prepare(other, WHERE_BLOCKERS, context);
  if (!under) {
    Correlate(right, right.source, keys.otherKey, local, form);
  }
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
    Replaced(CurrentValue(prepared), keys.localKey, looked),
  );
};

/** The stages that bring a second query into the pipeline beside the one it is folding. */
export const JOIN_STAGES: PipelineStageMap = {
  join: JoinStage,
  lookup: LookupStage,
};
