import type { CallRequest } from "@antelopejs/tooling-configs/verify";

/** A JSON value as the harness passes it to and reads it from the module. */
export type Json = NonNullable<CallRequest["args"]>[number];

/** A JSON object. */
interface JsonRecord {
  [key: string]: Json;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isJsonRecord(value: Json | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (isScalar(value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isJson)
  );
}

function isString(value: Json | undefined): value is string {
  return typeof value === "string";
}

function isIndex(step: string | number): step is number {
  return typeof step === "number";
}

/** The string `value` holds, or an empty string. */
export function text(value: Json | undefined): string {
  return isString(value) ? value : "";
}

/** Reads `value` down the given keys and indexes; `undefined` when a step is missing. */
export function pick(
  value: Json | undefined,
  ...path: (string | number)[]
): Json | undefined {
  let current = value;
  for (const step of path) {
    if (isIndex(step)) {
      current = Array.isArray(current) ? current[step] : undefined;
    } else {
      current =
        isJsonRecord(current) && Object.hasOwn(current, step)
          ? current[step]
          : undefined;
    }
  }
  return current;
}

/** The value with object keys in sorted order, so two values compare equal whatever order their keys were written in. */
export function canonical(value: Json | undefined): Json {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (isJsonRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** Parses JSON text; an empty or unparsable text reads as `undefined`, so a check reports what was printed instead of throwing. */
export function parseJson(raw: string): Json | undefined {
  if (raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJson(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
