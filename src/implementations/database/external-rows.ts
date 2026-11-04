import {
  type MeasureError,
  type MeasureTimeout,
  type RowSample,
  SAMPLE_ROWS_LIMIT,
  SAMPLE_TEXT_LENGTH,
  type SampledValue,
  type SampleRequest,
} from "@antelopejs/interface-database-catalog";

import { type CatalogColumn, ReadColumns } from "./external-catalog";
import { EstimateOf, RelationName } from "./external-discovery";
import { WithMeasures } from "./external-measures";
import { NamedRow } from "./external-profile";
import { SourceFor, SOURCE_ALIAS } from "./external-sample";
import { QuoteIdentifier } from "./sql";

const BINARY_TYPES: readonly string[] = ["bytea"];
const COLUMN_ALIAS_PREFIX = "c";

type SampledRow = Record<string, string | number | null>;

interface SampledColumn {
  name: string;
  binary: boolean;
}

function SampledColumnOf(column: CatalogColumn): SampledColumn {
  return {
    name: column.name,
    binary: BINARY_TYPES.includes(column.typname),
  };
}

function CheckedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SAMPLE_ROWS_LIMIT) {
    throw new Error(
      `A sample answers from 1 to ${SAMPLE_ROWS_LIMIT} rows, not ${limit}`,
    );
  }
  return limit;
}

function Chosen(
  columns: CatalogColumn[],
  request: SampleRequest,
): SampledColumn[] {
  const unknown = (request.columns ?? []).filter(
    (name) => !columns.some((column) => column.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Relation '${request.relation}' has no column ${unknown.join(", ")}`,
    );
  }
  return columns
    .filter(
      (column) => !request.columns || request.columns.includes(column.name),
    )
    .map(SampledColumnOf);
}

function Expression(column: SampledColumn, index: number): string {
  const value = `${SOURCE_ALIAS}.${QuoteIdentifier(column.name)}`;
  const read = column.binary
    ? `octet_length(${value})`
    : `left(${value}::text, ${SAMPLE_TEXT_LENGTH + 1})`;
  return `${read} AS ${COLUMN_ALIAS_PREFIX}${index}`;
}

function Value(
  column: SampledColumn,
  read: string | number | null,
): SampledValue {
  if (read === null) {
    return null;
  }
  if (column.binary) {
    return { bytes: Number(read) };
  }
  const text = String(read);
  return {
    text: text.slice(0, SAMPLE_TEXT_LENGTH),
    truncated: text.length > SAMPLE_TEXT_LENGTH,
  };
}

function Row(columns: SampledColumn[], row: SampledRow): SampledValue[] {
  return columns.map((column, index) => {
    const alias = `${COLUMN_ALIAS_PREFIX}${index}`;
    return Value(column, Object.hasOwn(row, alias) ? row[alias] : null);
  });
}

function FailureOf(measured: MeasureTimeout | MeasureError): string {
  return measured.status === "timeout" ? "timeout" : measured.code;
}

/**
 * The first rows of a relation, or of its sample above the sampling threshold, in one read-only
 * transaction. Every value is text cut at {@link SAMPLE_TEXT_LENGTH}, and a binary one its length.
 */
export async function SampleRelationRows(
  request: SampleRequest,
): Promise<RowSample> {
  const limit = CheckedLimit(request.limit);
  const row = await NamedRow(request.relation);
  const columns = Chosen(await ReadColumns(row.oid), request);
  const { estimatedRows } = await EstimateOf(row);
  const source = SourceFor(row, estimatedRows);
  const select = columns.map(Expression).join(", ");
  const measured = await WithMeasures((session) =>
    session.measure<SampledRow>(
      `SELECT ${select} FROM ${source.from} LIMIT $1`,
      [limit],
    ),
  );
  if (measured.status !== "ok") {
    throw new Error(
      `The sample of '${request.relation}' did not finish: ${FailureOf(measured)}`,
    );
  }
  return {
    relation: RelationName(row),
    columns: columns.map((column) => column.name),
    rows: measured.value.map((sampled) => Row(columns, sampled)),
    sample: source.sample && {
      ...source.sample,
      rows: measured.value.length,
    },
  };
}
