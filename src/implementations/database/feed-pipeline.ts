import assert from "node:assert";

import { QuoteIdentifier } from "./sql";
import { WRITE_STAGES } from "./writes";
import type { QueryStage } from "./utils";
import { DecodingContext } from "./context";
import { CompileSubquery } from "./subquery";
import { OPAQUE, type SqlType } from "./types";
import { CompileExpression } from "./expression";
import { ApplyStages, CompileRelation, PIPELINE_STAGES } from "./pipeline";
import {
  CurrentValue,
  LoggedRelation,
  type Relation,
  Render,
  type TableOrigin,
} from "./relation";

/**
 * The alias each side's one row is read through, fixed rather than taken from the context.
 * Each side renders into its own lateral subselect, so the name cannot collide outside it.
 */
const SIDE_ALIAS = "s";
const ROW_COLUMN = QuoteIdentifier("r");

const LOGGED_ROW = `${QuoteIdentifier(SIDE_ALIAS)}.${ROW_COLUMN}`;

const MATCHES_EVERYTHING = "TRUE";

export const DOC_KEY = "doc";
export const MATCHED_KEY = "matched";

/**
 * The stages a feed accepts before `changes()`, chosen by meaning rather than by what compiles.
 * `get` is the predicate alone here, and a `lookup` resolves as of delivery, not as of the event.
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
 * sides disagree; rendering twice is pure and binds no parameter, so it is the rendering rather
 * than the compilation that may be repeated.
 */
export interface FeedPlan {
  readonly oldSide: string;
  readonly newSide: string;
  readonly params: unknown[];
  readonly type: SqlType;
}

/**
 * Refuses a stage a feed cannot answer, naming the position as well as the stage.
 * Every stage refused here is legal one level out, so naming only the stage would mislead.
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
 * One side's select list: the document it projects beside whether it matched, as one jsonb value.
 * The `where` list is read as a boolean here and emptied from the relation.
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
 * Compiles the stages against one side's row, with the `from` real from the start.
 * A stage that wraps renders its input into its own `from`, where no later substitution reaches.
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
