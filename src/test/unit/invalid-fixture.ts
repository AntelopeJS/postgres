import type { WriteDocument } from "./pipeline-fixture";

/** A value that is not a document, passed where a write takes one, to reach the runtime refusal. */
export function NotADocument(value: unknown): WriteDocument {
  return value as WriteDocument;
}

/** A value that is not a string, passed where the builder takes one, to reach the runtime refusal. */
export function NotAString(value: unknown): string {
  return value as string;
}
