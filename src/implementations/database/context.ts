import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Relation } from "./relation";
import type { RowSource } from "./row-source";
import type { OriginResolver } from "./selection";
import { type Compiled, ParamCollector } from "./sql";

export type SubqueryProvider = (stages: QueryStage[]) => Compiled;

export type ArgumentBinding = RowSource | SubqueryProvider | Compiled;

type ExpressionCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
  source?: RowSource,
) => Compiled;

export type SubqueryCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
) => Compiled;

type RelationCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
) => Relation;

/**
 * The nested compilations a stage or an expression can ask for, injected rather than imported.
 *
 * Named rather than positional because `expression` and `subquery` take the same parameters and
 * answer the same type, so swapping them still typechecks and compiles the wrong thing — and those
 * two are exactly the pair the constructor used to carry positionally. `relation` answers a
 * different type and would be caught, which is not a reason to leave the other two exposed.
 *
 * A compilation belongs here only when the caller sits *below* the compiler it needs — `value.ts`
 * below `expression.ts`, a stage family below the dispatcher that merges it — so that importing it
 * outright would close a require cycle. Anything a caller can import is an import, not a hook.
 */
export interface Compilers {
  expression: ExpressionCompiler;
  subquery: SubqueryCompiler;
  relation: RelationCompiler;
}

const ALIAS_PREFIX = "t";

/**
 * Mutable state shared by every layer compiling a single statement: the parameter list, the
 * table alias counter and the bindings of lambda parameters.
 *
 * The compilers are injected so this module stays free of a circular import back onto them.
 */
export class DecodingContext {
  public readonly params = new ParamCollector();

  private readonly bindings: Record<number, ArgumentBinding> = {};
  private aliasCounter = 0;

  /**
   * @param compilers The nested compilations this statement's layers reach back for.
   * @param resolveOrigin How a root nested inside the stage tree — a union's right side — learns
   * about its table. This is the *other* kind of seam from {@link Compilers}, and the difference
   * is why it is a second parameter rather than a fourth member of it: the compilers are required
   * and exist because importing them outright would close a require cycle, while this one is
   * optional and exists only so a spec can compile against a stub registry — `selection.ts` can
   * import `schema.ts`, so production never sets it and falls back to `RegisteredOrigin`. Readonly
   * and supplied once because a reassignment mid-compilation would resolve a union's two sides
   * against different registries, with no failing type.
   */
  public constructor(
    private readonly compilers: Compilers,
    public readonly resolveOrigin?: OriginResolver,
  ) {}

  /** A context compiling a separate statement, with a ledger of its own and the same compilers. */
  public sibling(): DecodingContext {
    return new DecodingContext(this.compilers, this.resolveOrigin);
  }

  public nextAlias(): string {
    return `${ALIAS_PREFIX}${this.aliasCounter++}`;
  }

  public bind(id: number, binding: ArgumentBinding): void {
    this.bindings[id] = binding;
  }

  public unbind(id: number): void {
    delete this.bindings[id];
  }

  public arg(id: number): ArgumentBinding {
    const binding = Object.hasOwn(this.bindings, id)
      ? this.bindings[id]
      : undefined;
    assert(binding, `Unbound lambda parameter ${id}`);
    return binding;
  }

  public expression(stages: QueryStage[], source?: RowSource): Compiled {
    return this.compilers.expression(stages, this, source);
  }

  public subquery(stages: QueryStage[]): Compiled {
    return this.compilers.subquery(stages, this);
  }

  /** The one door to a query nested inside another one — see `CompileRelation`. */
  public relation(stages: QueryStage[]): Relation {
    return this.compilers.relation(stages, this);
  }
}
