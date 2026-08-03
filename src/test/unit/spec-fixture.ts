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
