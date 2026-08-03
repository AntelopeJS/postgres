import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";
import type { RowSource } from "./row-source";
import type { OriginResolver } from "./selection";
import { type Compiled, ParamCollector } from "./sql";

export type SubqueryProvider = (stages: QueryStage[]) => Compiled;

export type ArgumentBinding = RowSource | SubqueryProvider | Compiled;

export type ExpressionCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
  source?: RowSource,
) => Compiled;

export type SubqueryCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
) => Compiled;

const ALIAS_PREFIX = "t";

/**
 * Mutable state shared by every layer compiling a single statement: the parameter list, the
 * table alias counter and the bindings of lambda parameters.
 *
 * The expression and subquery compilers are injected so this module stays free of a circular
 * import back onto them.
 */
export class DecodingContext {
  public readonly params = new ParamCollector();

  /**
   * How a root nested inside the stage tree — a union's right side — learns about its table.
   *
   * Injected for the same reason the two compilers are; see {@link OriginResolver}. Left unset
   * outside a spec, where `RegisteredOrigin` is what a nested root falls back to.
   */
  public resolveOrigin?: OriginResolver;

  private readonly bindings: Record<number, ArgumentBinding> = {};
  private aliasCounter = 0;

  public constructor(
    private readonly compileExpression: ExpressionCompiler,
    private readonly compileSubquery: SubqueryCompiler,
  ) {}

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
    return this.compileExpression(stages, this, source);
  }

  public subquery(stages: QueryStage[]): Compiled {
    return this.compileSubquery(stages, this);
  }
}
