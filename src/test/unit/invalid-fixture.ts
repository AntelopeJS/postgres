import type { WriteDocument } from "./pipeline-fixture";
import type { QueryStage } from "@antelopejs/interface-database/common";

/** A value that is not a document, passed where a write takes one, to reach the runtime refusal. */
export function NotADocument(value: unknown): WriteDocument {
  return value as WriteDocument;
}

/** A value that is not a string, passed where the builder takes one, to reach the runtime refusal. */
export function NotAString(value: unknown): string {
  return value as string;
}

/**
 * A stage the typed builder cannot record, as an untyped caller rebuilding stages from JSON sends
 * it: any name, options and arguments, to reach the runtime refusal.
 */
export function UntypedStage(
  stage: string,
  options?: unknown,
  ...args: unknown[]
): QueryStage {
  // @ts-expect-error a stage outside the union, as an untyped caller sends it, which each calling test asserts the compiler's answer to
  return { stage, options, args };
}
