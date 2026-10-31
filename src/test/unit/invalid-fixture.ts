import type { WriteDocument } from "./pipeline-fixture";
import {
  QueryStage,
  StagedObject,
} from "@antelopejs/interface-database/common";

/** A value that is not a document, passed where a write takes one, to reach the runtime refusal. */
export function NotADocument(value: unknown): WriteDocument {
  return value as WriteDocument;
}

/** A value that is not a string, passed where the builder takes one, to reach the runtime refusal. */
export function NotAString(value: unknown): string {
  return value as string;
}

/**
 * Stages as dms-database's query route rebuilds them from a request's JSON, the way its
 * `decodeStaged` does: whatever the request holds, which the typed builder cannot record and the
 * compiler still answers.
 */
export function RebuiltFromJson(...stages: object[]): QueryStage[] {
  const rebuilt: unknown = JSON.parse(JSON.stringify(stages));
  return Object.assign(new StagedObject(QueryStage("changes")), {
    stages: rebuilt,
  }).build();
}
