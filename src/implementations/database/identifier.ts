import { createHash } from "node:crypto";
import { GetSchemaPrefix } from "../../connection";
import { QuoteIdentifier } from "./sql";
import { MAX_IDENTIFIER_BYTES } from "./utils";

const HASH_LENGTH = 7;
const HASH_SEPARATOR = "_";
const INDEX_NAME_SEPARATOR = "_";
const KEPT_BYTES = MAX_IDENTIFIER_BYTES - HASH_LENGTH - HASH_SEPARATOR.length;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;

function TruncateBytes(value: Buffer, limit: number): string {
  let end = limit;
  while (end > 0 && (value[end] & CONTINUATION_MASK) === CONTINUATION_BITS) {
    end--;
  }
  return value.subarray(0, end).toString("utf8");
}

/**
 * Fits an arbitrary name into PostgreSQL's 63-byte identifier limit.
 *
 * Names that fit are returned verbatim so the physical layout stays readable;
 * longer ones are truncated on a character boundary and suffixed with a short
 * digest of the full name, which keeps the mapping deterministic and injective
 * in practice.
 */
export function PgIdentifier(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_IDENTIFIER_BYTES) {
    return name;
  }
  const digest = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const truncated = TruncateBytes(Buffer.from(name, "utf8"), KEPT_BYTES);
  return `${truncated}${HASH_SEPARATOR}${digest}`;
}

export function SchemaName(schemaId: string): string {
  return PgIdentifier(`${GetSchemaPrefix()}${schemaId}`);
}

export function TableName(tableId: string): string {
  return PgIdentifier(tableId);
}

export function IndexName(tableId: string, indexId: string): string {
  return PgIdentifier(`${tableId}${INDEX_NAME_SEPARATOR}${indexId}`);
}

/** Qualifies any schema-scoped object — a table or an index — by physical name. */
export function QualifiedName(schemaName: string, objectName: string): string {
  return `${QuoteIdentifier(schemaName)}.${QuoteIdentifier(objectName)}`;
}

export function TableReference(schemaId: string, tableId: string): string {
  return QualifiedName(SchemaName(schemaId), TableName(tableId));
}
