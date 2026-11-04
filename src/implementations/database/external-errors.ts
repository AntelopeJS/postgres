import { IsDocument, IsString } from "./guards";
import { QualifiedName } from "./identifier";
import type { ExternalRelation } from "./fields";

/** What went wrong with a write, in terms a caller can act on without reading SQLSTATE codes. */
export type ExternalWriteErrorKind =
  | "invalid"
  | "missing"
  | "duplicate"
  | "reference"
  | "referenced"
  | "check"
  | "forbidden";

/**
 * A write to an external relation the database, or the adapter on its behalf, refused.
 *
 * It carries what a later mapping to an HTTP status needs — the kind, the field or the constraint,
 * the key PostgreSQL named — without importing anything an interface package defines: no layer maps
 * a provider error today, so the message is written to be read as it is.
 */
export class ExternalWriteError extends Error {
  public readonly kind: ExternalWriteErrorKind;
  public readonly fields: string[];
  public readonly constraint?: string;
  public readonly code?: string;
  public readonly detail?: string;

  public constructor(message: string, facts: ExternalWriteFacts) {
    super(message);
    this.name = "ExternalWriteError";
    this.kind = facts.kind;
    this.fields = facts.fields ?? [];
    this.constraint = facts.constraint;
    this.code = facts.code;
    this.detail = facts.detail;
  }
}

/** What an {@link ExternalWriteError} says beside its message. */
interface ExternalWriteFacts {
  kind: ExternalWriteErrorKind;
  fields?: string[];
  constraint?: string;
  code?: string;
  detail?: string;
}

interface DatabaseError {
  code?: string;
  column?: string;
  constraint?: string;
  table?: string;
  detail?: string;
  message: string;
}

function IsOptionalText(value: unknown): value is string | undefined {
  return value === undefined || IsString(value);
}

/**
 * Whether a thrown value carries the members a database error is read for.
 *
 * Structural rather than an `instanceof`, so an error from another copy of `pg-protocol` is read
 * the same; every member the mappings read is checked here.
 */
export function IsDatabaseError(value: unknown): value is DatabaseError {
  return (
    IsDocument(value) &&
    IsString(value.message) &&
    [
      value.code,
      value.column,
      value.constraint,
      value.table,
      value.detail,
    ].every(IsOptionalText)
  );
}

type Mapping = (error: DatabaseError, relation: string) => ExternalWriteError;

function Detail(error: DatabaseError): string {
  return error.detail ? `: ${error.detail}` : "";
}

const MAPPINGS = new Map<string, Mapping>([
  [
    "23502",
    (error, relation) =>
      new ExternalWriteError(
        `Field '${error.column}' of ${relation} is required`,
        {
          kind: "missing",
          fields: error.column ? [error.column] : [],
          code: error.code,
        },
      ),
  ],
  [
    "23505",
    (error, relation) =>
      new ExternalWriteError(
        `A row of ${relation} already has this value of unique "${error.constraint}"${Detail(error)}`,
        {
          kind: "duplicate",
          constraint: error.constraint,
          code: error.code,
          detail: error.detail,
        },
      ),
  ],
  [
    "23503",
    (error, relation) => {
      const referenced = (error.detail ?? "").includes("is still referenced");
      return new ExternalWriteError(
        referenced
          ? `The row of ${relation} is still referenced through "${error.constraint}"${Detail(error)}`
          : `A referenced row does not exist for "${error.constraint}" of ${relation}${Detail(error)}`,
        {
          kind: referenced ? "referenced" : "reference",
          constraint: error.constraint,
          code: error.code,
          detail: error.detail,
        },
      );
    },
  ],
  [
    "23514",
    (error, relation) =>
      new ExternalWriteError(
        `The row breaks check "${error.constraint}" of ${relation}`,
        { kind: "check", constraint: error.constraint, code: error.code },
      ),
  ],
  [
    "42501",
    (error, relation) =>
      new ExternalWriteError(
        `The connected role may not write to ${relation}: ${error.message}`,
        { kind: "forbidden", code: error.code },
      ),
  ],
]);

/** A database error from writing an external relation, as a readable {@link ExternalWriteError}. */
export function ExternalWriteFailure(
  error: DatabaseError,
  external: ExternalRelation,
): DatabaseError | ExternalWriteError {
  const mapping = error.code ? MAPPINGS.get(error.code) : undefined;
  if (!mapping) {
    return error;
  }
  return mapping(error, QualifiedName(external.schema, external.table));
}

/** The write a validation refused before it ran, naming every field that failed. */
export function InvalidValues(failures: string[]): ExternalWriteError {
  return new ExternalWriteError(failures.join("; "), {
    kind: "invalid",
    fields: failures.map(
      (failure) => /^Field '([^']*)'/.exec(failure)?.[1] ?? "",
    ),
  });
}
