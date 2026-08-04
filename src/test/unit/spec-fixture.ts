import {
  ClearOptions,
  GetOptions,
  type Options,
  SetOptions,
} from "../../config";

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
 * synchronous call, so no registration in flight can observe either (invariant 7).
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
 * the query, so the specs compare them directly rather than pinning one count (invariant 16).
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
