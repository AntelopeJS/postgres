import type {
  FanOut,
  InboundProfile,
  Measure,
  ProfileRequest,
  Reference,
  ReferenceProfile,
  RelationProfile,
  RowCount,
} from "@antelopejs/interface-database-catalog";

import {
  type ColumnRoles,
  Profiled,
  type ProfiledColumn,
  ProfileColumn,
} from "./external-column-profile";
import {
  type CatalogColumn,
  ReadColumns,
  ReadIndexes,
} from "./external-catalog";
import {
  EstimateOf,
  KeyFrom,
  ReadNamedRelationRows,
  ReadReferences,
  ReferenceOf,
  RelationName,
  type RelationRow,
} from "./external-discovery";
import {
  FirstRow,
  type MeasureSession,
  Sequentially,
  ValueOf,
  WithMeasures,
} from "./external-measures";
import {
  SAMPLE_THRESHOLD_ROWS,
  type Source,
  SourceFor,
} from "./external-sample";
import { QualifiedName } from "./identifier";
import { QuoteIdentifier } from "./sql";

interface CountRow {
  rows: number;
}

interface FanOutRow {
  average: number | null;
  max: number | null;
  parentsWithoutChildren: number;
}

async function CountRows(
  session: MeasureSession,
  row: RelationRow,
  estimate: number | null,
): Promise<Measure<RowCount>> {
  if (estimate !== null && estimate > SAMPLE_THRESHOLD_ROWS) {
    return { status: "ok", value: { rows: estimate, exact: false } };
  }
  const measured = await session.measure<CountRow>(
    `SELECT count(*)::float8 AS rows FROM ${QualifiedName(row.schema, row.name)}`,
  );
  return FirstRow(measured, (counted) => ({ rows: counted.rows, exact: true }));
}

/** Rows every column measure reads: the relation's own count, or the sample's. */
async function MeasuredRows(
  session: MeasureSession,
  source: Source,
  counted: Measure<RowCount>,
): Promise<number | undefined> {
  if (!source.sample) {
    return ValueOf(counted)?.rows;
  }
  const measured = await session.measure<CountRow>(
    `SELECT count(*)::float8 AS rows FROM ${source.from}`,
  );
  const rows = ValueOf(measured)?.[0]?.rows;
  source.sample.rows = rows ?? 0;
  return rows;
}

function ColumnTuple(alias: string, columns: string[]): string {
  return `(${columns.map((column) => `${alias}.${QuoteIdentifier(column)}`).join(", ")})`;
}

function QualifiedOf(relation: string): string {
  const dot = relation.indexOf(".");
  return QualifiedName(relation.slice(0, dot), relation.slice(dot + 1));
}

function FanOutSql(reference: Reference): string {
  const child = QualifiedOf(reference.from.relation);
  const parent = QualifiedOf(reference.to.relation);
  const childKey = ColumnTuple("c", reference.from.columns);
  const parentKey = ColumnTuple("p", reference.to.columns);
  const filled = reference.from.columns
    .map((column) => `c.${QuoteIdentifier(column)} IS NOT NULL`)
    .join(" AND ");
  return `SELECT
    (SELECT avg(n) FROM (SELECT count(*) AS n FROM ${child} AS c WHERE ${filled} GROUP BY ${childKey}) g)::float8 AS average,
    (SELECT max(n) FROM (SELECT count(*) AS n FROM ${child} AS c WHERE ${filled} GROUP BY ${childKey}) g)::float8 AS max,
    (SELECT count(*) FROM ${parent} AS p WHERE NOT EXISTS (
      SELECT 1 FROM ${child} AS c WHERE ${childKey} = ${parentKey}))::float8 AS "parentsWithoutChildren"`;
}

async function ProfileReference(
  session: MeasureSession,
  reference: Reference,
): Promise<ReferenceProfile> {
  const measured = await session.measure<FanOutRow>(FanOutSql(reference));
  const fanOut = FirstRow<FanOutRow, FanOut>(measured, (row) => ({
    average: row.average ?? 0,
    max: row.max ?? 0,
    parentsWithoutChildren: row.parentsWithoutChildren,
  }));
  return { reference, fanOut };
}

async function Inbound(references: Reference[]): Promise<InboundProfile[]> {
  const rows = await ReadNamedRelationRows(
    references.map((reference) => reference.from.relation),
  );
  const byName = new Map(rows.map((row) => [RelationName(row), row]));
  return Promise.all(
    references.map(async (reference) => {
      const row = byName.get(reference.from.relation);
      const estimate = row ? (await EstimateOf(row)).estimatedRows : null;
      return { reference, estimatedRows: estimate };
    }),
  );
}

async function NamedRow(relation: string): Promise<RelationRow> {
  const [row] = await ReadNamedRelationRows([relation]);
  if (!row) {
    throw new Error(
      `Relation '${relation}' does not exist, or the connected role cannot see it`,
    );
  }
  if (!row.readable) {
    throw new Error(
      `Relation '${relation}' cannot be read by the connected role`,
    );
  }
  return row;
}

function Selected(
  columns: CatalogColumn[],
  request: ProfileRequest,
): ProfiledColumn[] {
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
    .map(Profiled)
    .filter((column): column is ProfiledColumn => column !== undefined);
}

/** Everything a profile needs from the catalog, read before its transaction opens. */
interface ProfilePlan {
  relation: string;
  row: RelationRow;
  estimate: number | null;
  source: Source;
  columns: ProfiledColumn[];
  outgoing: Reference[];
  inbound: InboundProfile[];
  roles: ColumnRoles;
}

async function PlanProfile(request: ProfileRequest): Promise<ProfilePlan> {
  const row = await NamedRow(request.relation);
  const relation = RelationName(row);
  const [columns, indexes, referenceRows] = await Promise.all([
    ReadColumns(row.oid),
    ReadIndexes(row.oid),
    ReadReferences(row.oid),
  ]);
  const references = referenceRows.map(ReferenceOf);
  const outgoing = references.filter(
    (reference) => reference.from.relation === relation,
  );
  const { estimatedRows } = await EstimateOf(row);
  return {
    relation,
    row,
    estimate: estimatedRows,
    source: SourceFor(row, estimatedRows),
    columns: Selected(columns, request),
    outgoing,
    inbound: await Inbound(
      references.filter((reference) => reference.to.relation === relation),
    ),
    roles: {
      keys: new Set(KeyFrom(indexes, columns)?.columns ?? []),
      references: new Set(
        outgoing.flatMap((reference) => reference.from.columns),
      ),
    },
  };
}

/**
 * Aggregates over one relation, in one read-only transaction. A relation estimated above
 * {@link SAMPLE_THRESHOLD_ROWS} is sampled; a value is named only as a category.
 */
export async function ProfileRelation(
  request: ProfileRequest,
): Promise<RelationProfile> {
  const plan = await PlanProfile(request);
  return WithMeasures(async (session) => {
    const rows = await CountRows(session, plan.row, plan.estimate);
    const measured = await MeasuredRows(session, plan.source, rows);
    const columns = await Sequentially(plan.columns, (column) =>
      ProfileColumn(session, column, plan.source, measured, plan.roles),
    );
    const references = await Sequentially(plan.outgoing, (reference) =>
      ProfileReference(session, reference),
    );
    return {
      relation: plan.relation,
      rows,
      sample: plan.source.sample,
      columns,
      references,
      inbound: plan.inbound,
    };
  });
}
