import type {
  ColumnReference,
  Measure,
  ReferenceCheck,
  ReferenceMatch,
} from "@antelopejs/interface-database-catalog";

import {
  type CatalogColumn,
  ReadColumns,
  ReadIndexes,
} from "./external-catalog";
import {
  EstimateOf,
  KeyFrom,
  ReadNamedRelationRows,
  type RelationRow,
} from "./external-discovery";
import { FirstRow, WithMeasures } from "./external-measures";
import { SourceFor } from "./external-sample";
import { QualifiedName } from "./identifier";
import { QuoteIdentifier } from "./sql";

/** One side of a reference check, resolved against the catalog. */
interface Side {
  row: RelationRow;
  column: CatalogColumn;
  columns: CatalogColumn[];
}

interface MatchRow {
  checked: number;
  found: number;
}

async function Resolve(reference: ColumnReference): Promise<Side> {
  const [row] = await ReadNamedRelationRows([reference.relation]);
  if (!row || !row.readable) {
    throw new Error(
      `Relation '${reference.relation}' does not exist, or the connected role cannot read it`,
    );
  }
  const columns = await ReadColumns(row.oid);
  const column = columns.find(
    (candidate) => candidate.name === reference.column,
  );
  if (!column) {
    throw new Error(
      `Relation '${reference.relation}' has no column ${reference.column}`,
    );
  }
  return { row, column, columns };
}

async function IsKey(side: Side): Promise<boolean> {
  const key = KeyFrom(await ReadIndexes(side.row.oid), side.columns);
  return key?.columns.length === 1 && key.columns[0] === side.column.name;
}

/** Native equality when both columns share a type, so the target's index serves it; text otherwise. */
function Equality(from: Side, to: Side): string {
  const left = `t.${QuoteIdentifier(to.column.name)}`;
  const right = `f.${QuoteIdentifier(from.column.name)}`;
  return from.column.castType === to.column.castType
    ? `${left} = ${right}`
    : `${left}::text = ${right}::text`;
}

/**
 * How many of a column's non-null values another column holds, for a reference the database does
 * not declare, in the same read-only transaction a profile uses.
 */
export async function CheckColumnReference(
  check: ReferenceCheck,
): Promise<Measure<ReferenceMatch>> {
  const from = await Resolve(check.from);
  const to = await Resolve(check.to);
  const source = SourceFor(
    from.row,
    (await EstimateOf(from.row)).estimatedRows,
    "f",
  );
  const targetIsKey = await IsKey(to);
  const target = QualifiedName(to.row.schema, to.row.name);
  const sql = `SELECT count(*)::float8 AS checked,
    (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${target} AS t WHERE ${Equality(from, to)})))::float8 AS found
    FROM ${source.from} WHERE f.${QuoteIdentifier(from.column.name)} IS NOT NULL`;
  return WithMeasures(async (session) =>
    FirstRow(await session.measure<MatchRow>(sql), (row) => ({
      containment: row.checked > 0 ? row.found / row.checked : 0,
      checkedRows: row.checked,
      sampled: source.sample !== null,
      targetIsKey,
    })),
  );
}
