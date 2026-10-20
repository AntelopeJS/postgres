import type { SampleInfo } from "@antelopejs/interface-database-catalog";

import type { RelationRow } from "./external-discovery";
import { QualifiedName } from "./identifier";

/** Above this many estimated rows a relation is sampled rather than read whole. */
export const SAMPLE_THRESHOLD_ROWS = 1_000_000;
const SAMPLE_TARGET_ROWS = 100_000;
const SAMPLE_SEED = 42;
const PERCENT = 100;

/** The alias every measure reads its relation under. */
export const SOURCE_ALIAS = "r";

const SAMPLED_KINDS: readonly string[] = ["r", "p", "m"];

/** What every measure reads `FROM`, and how it was cut down. */
export interface Source {
  from: string;
  sample: SampleInfo | null;
}

/** A relation's rows, sampled above {@link SAMPLE_THRESHOLD_ROWS}: by blocks where the kind allows. */
export function SourceFor(
  row: RelationRow,
  estimate: number | null,
  alias = SOURCE_ALIAS,
): Source {
  const table = `${QualifiedName(row.schema, row.name)} AS ${alias}`;
  if (estimate === null || estimate <= SAMPLE_THRESHOLD_ROWS) {
    return { from: table, sample: null };
  }
  const percent = Math.min(PERCENT, (SAMPLE_TARGET_ROWS / estimate) * PERCENT);
  if (SAMPLED_KINDS.includes(row.kind)) {
    return {
      from: `${table} TABLESAMPLE SYSTEM (${percent}) REPEATABLE (${SAMPLE_SEED})`,
      sample: { percent, rows: 0 },
    };
  }
  return {
    from: `(SELECT * FROM ${QualifiedName(row.schema, row.name)} LIMIT ${SAMPLE_TARGET_ROWS}) AS ${alias}`,
    sample: { percent, rows: 0 },
  };
}
