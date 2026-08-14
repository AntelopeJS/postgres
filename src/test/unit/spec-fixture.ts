import {
  ClearOptions,
  GetOptions,
  type Options,
  SetOptions,
} from "../../config";
import type { Compilers } from "../../implementations/database/context";

function Refusing(kind: string): () => never {
  return () => {
    throw new Error(`this spec compiles no ${kind}`);
  };
}

/**
 * A `Compilers` whose every hook refuses, so a spec opts in to the nesting it means to exercise.
 *
 * Spread with an override rather than passed as it is: a spec that reaches a hook it did not name
 * has compiled something it did not intend, and a refusal says so where a working default would
 * quietly answer.
 */
export function RefusingCompilers(): Compilers {
  return {
    expression: Refusing("expression"),
    subquery: Refusing("subquery"),
    relation: Refusing("relation"),
  };
}

function CurrentOptions(): Options | undefined {
  try {
    return GetOptions();
  } catch {
    return undefined;
  }
}

/**
 * Runs a synchronous body through a temporary configuration, restoring whatever was there.
 *
 * Every generated name goes through `SchemaName`, which reads the process-wide schema prefix, and
 * these specs share their process with a live, constructed adapter: `pnpm test` runs them
 * alongside the conformance suites. Both the set and the restore therefore happen inside one
 * synchronous call, so no registration in flight can observe either.
 */
export function WithOptions<T>(options: Options, read: () => T): T {
  const saved = CurrentOptions();
  SetOptions(options);
  try {
    return read();
  } finally {
    if (saved) {
      SetOptions(saved);
    } else {
      ClearOptions();
    }
  }
}

/**
 * Runs an asynchronous body with *a* configuration in place, leaving an existing one alone.
 *
 * {@link WithOptions} cannot serve a body that awaits: it restores synchronously, so a continuation
 * resuming in a later turn reads whatever replaced its set. Holding a set across an await is
 * a hazard exactly when a concurrent registration could observe it, and here there is nothing —
 * under `pnpm test` the live adapter configured this process before the specs ran and this changes
 * nothing at all, and under a standalone unit run there is no registration to observe the set.
 *
 * What it buys is the compile path that reads options *after* the readiness gate: every generated
 * name goes through `SchemaName`, and the gate is one await earlier.
 */
export async function WhileConfigured<T>(body: () => Promise<T>): Promise<T> {
  if (CurrentOptions()) {
    return body();
  }
  SetOptions({});
  try {
    return await body();
  } finally {
    ClearOptions();
  }
}

/** How many times a fragment appears in a rendered statement — the shape of the duplication specs. */
export function Occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export interface ParamLedger {
  referenced: number[];
  bound: number[];
}

const PARAM_MARKER = /\$(\d+)/g;
const FIRST_PARAM = 1;

function Ascending(left: number, right: number): number {
  return left - right;
}

/**
 * The `$n` positions a compiled statement references, beside the positions the bind will supply.
 *
 * Every compiled fragment appends to the one collector, so a branch that was compiled and then
 * discarded — or a relation rendered twice — makes these two lists differ. PostgreSQL reports it
 * as `bind message supplies N parameters, but prepared statement requires M`, naming nothing about
 * the query, so the specs compare them directly rather than pinning one count.
 *
 * It lives here rather than beside either caller because a second scan of the same markers would
 * let one spec family keep passing a check the other had already found wrong.
 */
export function ParamLedgerOf(sql: string, bound: number): ParamLedger {
  const markers = [...sql.matchAll(PARAM_MARKER)].map((match) =>
    Number(match[1]),
  );
  return {
    referenced: [...new Set(markers)].sort(Ascending),
    bound: Array.from({ length: bound }, (_, index) => index + FIRST_PARAM),
  };
}
