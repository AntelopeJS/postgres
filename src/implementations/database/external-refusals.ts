import { QualifiedName } from "./identifier";
import type { ExternalRelation } from "./fields";

function Named(external: ExternalRelation): string {
  return QualifiedName(external.schema, external.table);
}

/** Refuses a write: an external relation is read, and its rows belong to its database's owner. */
export function ExternalWriteRefusal(
  external: ExternalRelation,
  stage: string,
): Error {
  return new Error(
    `The '${stage}' stage writes, and ${Named(external)} is an external relation: external tables are read-only in this version`,
  );
}

/** Refuses a feed, which needs the change log and triggers an owned table has and this one does not. */
export function ExternalFeedRefusal(external: ExternalRelation): Error {
  return new Error(
    `changes() needs the adapter's change log, which ${Named(external)} does not have: it is an external relation, and the adapter installs nothing on it`,
  );
}

/** Refuses an instance lifecycle stage, since an external relation has no instances to manage. */
export function ExternalInstanceRefusal(stage: string): Error {
  return new Error(
    `The '${stage}' stage manages instances, and an external instance's relations have none: read them through the default instance`,
  );
}

/** Refuses reading by key a relation that has none, naming the field reads that still work. */
export function KeylessRefusal(external: ExternalRelation): Error {
  return new Error(
    `${Named(external)} has no primary key and no unique index over NOT NULL columns, so its rows have no _id and cannot be read by key: filter on a field, or getAll by a field name`,
  );
}
