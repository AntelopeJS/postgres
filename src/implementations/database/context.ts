import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";
import type { RowSource } from "./row-source";
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
