import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

export type { QueryStage } from "@antelopejs/interface-database/common";

export const ID_COLUMN = "_id";
export const INSTANCE_COLUMN = "_instance";
export const EXTRA_COLUMN = "_extra";

/** Columns the adapter owns; no declared field and no overflow key may land in one. */
export const RESERVED_COLUMNS: readonly string[] = [
  ID_COLUMN,
  INSTANCE_COLUMN,
  EXTRA_COLUMN,
];

/**
 * The reserved columns a schema definition may not name, which is not all of them.
 *
 * `_id` is absent because a schema declaring it restates the key column the adapter already
 * stores rather than asking for a column of its own; the other two are bookkeeping a caller has
 * no way to mean.
 */
export const UNDECLARABLE_COLUMNS: readonly string[] = [
  INSTANCE_COLUMN,
  EXTRA_COLUMN,
];

/** Instance id stored for the unnamed (default) instance. */
export const DEFAULT_INSTANCE_ID = "";

export const REGISTRY_SCHEMA = "__antelope";
export const REGISTRY_INSTANCES_TABLE = "instances";
export const CHANGE_LOG_TABLE = "changes";
export const CHANGE_REAPED_TABLE = "changes_reaped";

/** PostgreSQL truncates identifiers past this many bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

export const CREATE_INSTANCE = "createInstance";
export const DESTROY_INSTANCE = "destroyInstance";

/**
 * The lifecycle stages that resolve an instance id, named once for both the
 * handler map that dispatches them and the errors that report them.
 */
export type InstanceOperation =
  | typeof CREATE_INSTANCE
  | typeof DESTROY_INSTANCE;

/**
 * Resolves the instance id an instance lifecycle stage names.
 *
 * An omitted id means the default instance, which is stored as the empty
 * string rather than as NULL so it compares like any other. An id passed
 * explicitly as `""` is that same default instance, not a named instance whose
 * name happens to be empty — the two are indistinguishable by construction.
 * `CROSS_INSTANCE` selects rows across instances and so has no meaning for an
 * operation that creates, destroys or enumerates one; it is rejected by name so
 * the caller sees which stage refused it.
 */
export function NormalizeInstanceId(
  operation: InstanceOperation,
  id: unknown,
): string {
  if (id === CROSS_INSTANCE) {
    throw new Error(
      `${operation} does not accept CROSS_INSTANCE: pass a string id or omit it for the default instance`,
    );
  }
  if (id === undefined || id === null) {
    return DEFAULT_INSTANCE_ID;
  }
  if (typeof id !== "string") {
    throw new Error(
      `${operation} expects a string instance id, received ${typeof id}`,
    );
  }
  return id;
}
