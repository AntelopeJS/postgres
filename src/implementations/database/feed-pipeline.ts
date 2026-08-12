import assert from "node:assert";
import { DecodingContext } from "./context";
import { CompileExpression } from "./expression";
import { ApplyStages, CompileRelation, PIPELINE_STAGES } from "./pipeline";
import {
  CurrentValue,
  LoggedRelation,
  type Relation,
  Render,
  type TableOrigin,
} from "./relation";
import { QuoteIdentifier } from "./sql";
import { CompileSubquery } from "./subquery";
import { OPAQUE, type SqlType } from "./types";
import type { QueryStage } from "./utils";
import { WRITE_STAGES } from "./writes";

/**
 * The alias each side's one row is read through.
 *
 * Fixed rather than taken from the context, and that is what lets one compilation serve both
 * sides: each side is rendered into its own lateral subselect, so the name is scoped to that
 * subselect and cannot collide with anything outside it. A nested `lookup` still takes its aliases
 * from the context, which never produces this one.
 */
const SIDE_ALIAS = "s";
const ROW_COLUMN = QuoteIdentifier("r");

export const LOGGED_ROW = `${QuoteIdentifier(SIDE_ALIAS)}.${ROW_COLUMN}`;

const MATCHES_EVERYTHING = "TRUE";

export const DOC_KEY = "doc";
export const MATCHED_KEY = "matched";

/**
 * The stages a feed accepts before `changes()`.
 *
 * Decided by *meaning* rather than by what happens to compile. The selection stages are here
 * because they name **fields**, not indexes: whether a stage reaches a btree is an optimization a
 * caller should never have to think about, and making someone rewrite `get(k).changes()` as
 * `filter(d => d.key("_id").eq(k)).changes()` would fracture an otherwise uniform syntax for an
 * internal reason. On a feed they are predicates over the event document like any other.
 *
 * One divergence to state rather than leave to be discovered: `get` on the read path bounds a
 * `CROSS_INSTANCE` query to one row, lowest `_instance` first. That is a bound on a *relation* and
 * means nothing on a stream of independent events, so on a feed `get(k)` is the predicate alone —
 * which is what it compiles to here, since a feed's relation is never cross-instance.
 *
 * `lookup` resolves **as of delivery**, not as of the event. The joined row's state at event time
 * is not recoverable from the log, and the alternative is refusing something useful.
 */
const FEED_STAGES: readonly string[] = [
  "filter",
  "map",
  "pluck",
  "without",
  "key",
  "default",
  "get",
  "getAll",
  "between",
  "lookup",
];

const ACCEPTED = new Set(FEED_STAGES);

/**
 * What the stages compile to, rendered once per side of an event.
 *
 * The two sides differ in exactly one substring — which column of the log row they read — so the
 * relation is compiled **once** and rendered twice against two `from` expressions. Compiling twice
 * would be two chances to diverge, and a divergence would be invisible until an event whose two
 * sides disagree; rendering twice is pure and binds no parameter, which is the half of invariant 16
 * that may be repeated.
 */
export interface FeedPlan {
  readonly oldSide: string;
  readonly newSide: string;
  readonly params: unknown[];
  readonly type: SqlType;
}

/**
 * Refuses a stage a feed cannot answer, **naming the position as well as the stage**.
 *
 * Every stage refused here is legal on the query one level out, so a message naming only the stage
 * tells a caller their code is wrong somewhere they cannot see: `count()` before a `changes()` is
 * not "count is unsupported". A stage nothing at all knows about keeps the fold's own wording,
 * since that one is a typo rather than a misplacement.
 */
function RefuseStage(stage: QueryStage): never {
  const known =
    Object.hasOwn(PIPELINE_STAGES, stage.stage) ||
    Object.hasOwn(WRITE_STAGES, stage.stage);
  if (known) {
    throw new Error(
      `The '${stage.stage}' stage cannot be used before 'changes': it needs a total order or a finite relation, and a change feed is neither`,
    );
  }
  throw new Error(`Unsupported query stage '${stage.stage}'`);
}

function Accepted(stages: QueryStage[]): QueryStage[] {
  for (const stage of stages) {
    if (!ACCEPTED.has(stage.stage)) {
      RefuseStage(stage);
    }
  }
  return stages;
}

/** The admission test for one side: every predicate the stages absorbed, or nothing to test. */
function Matches(where: readonly string[]): string {
  return where.length > 0 ? where.join(" AND ") : MATCHES_EVERYTHING;
}

function SideFrom(column: string): string {
  return `(SELECT ${column} AS ${ROW_COLUMN})`;
}

/**
 * One side's select list: the document it projects beside whether it matched.
 *
 * They travel as one jsonb value rather than as two columns because a relation projects exactly
 * one, and splitting them would mean rendering the same relation twice per side — which is where a
 * `lookup`'s join would be executed twice for an answer that is already to hand.
 *
 * The `where` list is read as a **boolean** here and emptied from the relation, which is the whole
 * of decision 1: the stages absorbed their predicates in the ordinary way, and this is the only
 * place that reads them as a value. `filter` itself is untouched.
 */
function Side(folded: Relation): Relation {
  const document = CurrentValue(folded);
  return {
    ...folded,
    where: [],
    projection: {
      sql: `jsonb_build_object('${DOC_KEY}', ${document.sql}, '${MATCHED_KEY}', ${Matches(folded.where)})`,
      type: OPAQUE,
    },
  };
}

/**
 * Compiles the stages against one side's row.
 *
 * The `from` is real from the start rather than filled in at render time, and that is not a detail:
 * a stage that *wraps* — a `filter` after a projection is the ordinary case — renders the relation
 * it wrapped into its own `from`, so a placeholder would be baked into the middle of the statement
 * where no later substitution reaches it.
 */
function CompileSide(
  stages: QueryStage[],
  origin: TableOrigin,
  context: DecodingContext,
  column: string,
): Relation {
  const relation = LoggedRelation(
    SideFrom(column),
    SIDE_ALIAS,
    LOGGED_ROW,
    origin,
  );
  return ApplyStages(relation, stages, context);
}

/**
 * Compiles the stages once against a logged row, and renders both sides of the event from it.
 *
 * **The relation-per-side is the mechanism rather than an economy.** Sourcing the stages directly
 * off the log's two columns looks simpler and breaks immediately: `filter` *absorbs into the
 * relation's `WHERE`*, and deciding "matched before **or** matches now" needs that predicate as a
 * boolean value. Giving `filter` a second behaviour that exists only for feeds would be a special
 * case in the one place the relation builder was designed not to have them.
 *
 * So each side is an ordinary relation over one row, folded by the ordinary fold, and `lookup`
 * works for free because that side is a real `FROM` which can join real tables.
 *
 * The predicate is evaluated **independently on both sides** and the caller admits the event if
 * either matched. Testing one document instead — `COALESCE(new, old)` — silently drops every event
 * where a row *leaves* the filter, because an update always has a new row to prefer. That is the
 * most consequential wrong answer available here, and no conformance case would catch it.
 *
 * The documents follow the **operation**, not the membership: an update carries both sides even
 * where one of them no longer matches, which is what lets a consumer see what a row looked like
 * before it left the filter.
 *
 * A feed always ends in a projection, so the row-mode select list — and `RequireOrigin`'s internal
 * assertion behind it — is never reached. That is asserted rather than relied upon.
 */
export function CompileFeed(
  stages: QueryStage[],
  origin: TableOrigin,
  oldRow: string,
  newRow: string,
): FeedPlan {
  const context = new DecodingContext({
    expression: CompileExpression,
    subquery: CompileSubquery,
    relation: CompileRelation,
  });
  const accepted = Accepted(stages);
  const folded = [oldRow, newRow].map((column) =>
    CompileSide(accepted, origin, context, column),
  );
  const sides = folded.map(Side);
  for (const side of sides) {
    assert(side.projection, "A change feed's side must project a document");
  }
  return {
    oldSide: Render(sides[0]),
    newSide: Render(sides[1]),
    params: context.params.all(),
    type: CurrentValue(folded[0]).type,
  };
}
