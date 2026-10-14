import type { CatalogColumn } from "./external-catalog";
import {
  ElementFamily,
  FamilyOf,
  type NativeFamily,
  ReadingOf,
} from "./external-types";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  OPAQUE,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "./types";

/** The scalar kind each family is proposed as: the reading a generator writes unless told otherwise. */
const PROPOSED_KIND: Record<Exclude<NativeFamily, "array">, SqlType> = {
  text: TEXT,
  citext: TEXT,
  bpchar: TEXT,
  uuid: TEXT,
  enum: TEXT,
  rendered: TEXT,
  int: FLOAT,
  int8: FLOAT,
  numeric: FLOAT,
  float4: FLOAT,
  float8: FLOAT,
  bool: BOOL,
  timestamptz: TIMESTAMP,
  timestamp: TIMESTAMP,
  date: TIMESTAMP,
  jsonb: OPAQUE,
  json: OPAQUE,
};

const SCALAR_KINDS: readonly SqlType[] = [TEXT, FLOAT, BOOL, TIMESTAMP, OPAQUE];

const FIELD_TOKENS: Record<Exclude<SqlType["kind"], "array">, string> = {
  text: "string",
  float: "number",
  bool: "boolean",
  timestamp: "date",
  json: "object",
};

const ARRAY_SUFFIX = "[]";

/** A declaration registration accepts for a column, as the `@Field` token and the parsed kind. */
export interface AcceptedDeclaration {
  declared: string;
  kind: SqlType;
  lossy?: string;
}

function FieldToken(kind: SqlType): string {
  return kind.kind === "array"
    ? `${FieldToken(kind.elem)}${ARRAY_SUFFIX}`
    : FIELD_TOKENS[kind.kind];
}

function ProposedFirst(kinds: SqlType[], proposed: SqlType): SqlType[] {
  return [
    ...kinds.filter((kind) => kind === proposed),
    ...kinds.filter((kind) => kind !== proposed),
  ];
}

function CandidateKinds(column: CatalogColumn): SqlType[] {
  const family = FamilyOf(column);
  if (family === "array") {
    const element = ElementFamily(column);
    const proposed =
      element && element !== "array" ? PROPOSED_KIND[element] : undefined;
    return ProposedFirst([...SCALAR_KINDS], proposed ?? TEXT).map(ArrayOf);
  }
  return family ? ProposedFirst([...SCALAR_KINDS], PROPOSED_KIND[family]) : [];
}

/**
 * Every declaration registration accepts for a column, the one a generator should propose first,
 * each with the reason it does not round-trip when it does not. The same tables {@link Describe}
 * reads decide it, so a declaration listed here is one registration takes.
 */
export function AcceptedDeclarations(
  column: CatalogColumn,
): AcceptedDeclaration[] {
  const family = FamilyOf(column);
  return CandidateKinds(column).flatMap((kind) => {
    const reading = ReadingOf(kind, family, column);
    return reading
      ? [{ declared: FieldToken(kind), kind, lossy: reading.lossy }]
      : [];
  });
}

/** Why no declaration reads a column, for a catalog that lists it anyway. */
export function UnsupportedReason(column: CatalogColumn): string {
  return `no field type reads a ${column.native} column`;
}
