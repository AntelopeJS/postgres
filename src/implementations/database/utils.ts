export type { QueryStage } from "@antelopejs/interface-database/common";

export const ID_COLUMN = "_id";
export const INSTANCE_COLUMN = "_instance";
export const EXTRA_COLUMN = "_extra";

/** Columns the adapter owns; a schema definition may not declare them. */
export const RESERVED_COLUMNS: readonly string[] = [
  ID_COLUMN,
  INSTANCE_COLUMN,
  EXTRA_COLUMN,
];

/** Instance id stored for the unnamed (default) instance. */
export const DEFAULT_INSTANCE_ID = "";

export const REGISTRY_SCHEMA = "__antelope";
export const REGISTRY_INSTANCES_TABLE = "instances";

/** PostgreSQL truncates identifiers past this many bytes. */
export const MAX_IDENTIFIER_BYTES = 63;
