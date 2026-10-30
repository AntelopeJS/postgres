/** Whether a stage argument or caller value is a string. */
export function IsString(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether a stage argument or caller value is a number. */
export function IsNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Whether a stage argument or caller value is an object other than `null`, arrays included. */
export function IsObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Whether a stage argument or caller value is a boolean. */
export function IsBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Whether a caller value is a document: an object other than `null` that is not an array.
 *
 * An array is not a document: the payload splitter reads any object's own keys, so a list would be
 * stored as an overflow document keyed by its indices rather than refused.
 */
export function IsDocument(value: unknown): value is Record<string, unknown> {
  return IsObject(value) && !Array.isArray(value);
}
