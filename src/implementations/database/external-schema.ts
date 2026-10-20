import type {
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { IndexFields } from "./ddl";
import { ID_COLUMN } from "./utils";
import { QualifiedName } from "./identifier";
import {
  type CatalogColumn,
  type CatalogRelation,
  ReadRelation,
} from "./external-catalog";
import {
  type ColumnDescriptor,
  Describe,
  DescribeKeyColumns,
} from "./external-types";
import type {
  ExternalRelation,
  FieldSpec,
  SchemaShape,
  TableShape,
} from "./fields";

/** One declared table on its way to a shape: its names, its declaration and what it parsed to. */
interface DeclaredTable {
  schemaId: string;
  tableId: string;
  table: TableDefinition;
  parsed: TableShape;
}

function PathOf(declared: DeclaredTable): string {
  return `${declared.schemaId}.${declared.tableId}`;
}

function NativeName(declared: DeclaredTable): string {
  return QualifiedName(declared.schemaId, declared.tableId);
}

function MissingRelation(declared: DeclaredTable): Error {
  return new Error(
    `Table '${PathOf(declared)}' reads ${NativeName(declared)}, which the database does not have`,
  );
}

function UnreadableRelation(declared: DeclaredTable): Error {
  return new Error(
    `Table '${PathOf(declared)}' reads ${NativeName(declared)}, which the connected role cannot SELECT from`,
  );
}

function MissingColumn(declared: DeclaredTable, field: string): Error {
  return new Error(
    `Field '${PathOf(declared)}.${field}' reads column "${field}", which ${NativeName(declared)} does not have`,
  );
}

function KeylessAlias(declared: DeclaredTable): Error {
  return new Error(
    `Field '${PathOf(declared)}.${ID_COLUMN}' aliases the relation's key, but ${NativeName(declared)} has no primary key and no unique index over NOT NULL columns; remove it`,
  );
}

async function ReadDeclared(declared: DeclaredTable): Promise<CatalogRelation> {
  const relation = await ReadRelation(declared.schemaId, declared.tableId);
  if (!relation) {
    throw MissingRelation(declared);
  }
  if (!relation.readable) {
    throw UnreadableRelation(declared);
  }
  return relation;
}

function ColumnsByName(relation: CatalogRelation): Map<string, CatalogColumn> {
  return new Map(relation.columns.map((column) => [column.name, column]));
}

function WarnLossy(
  declared: DeclaredTable,
  descriptor: ColumnDescriptor,
): void {
  if (descriptor.lossy) {
    Logger.Warn(
      `Field '${PathOf(declared)}.${descriptor.field}' over ${descriptor.native} is read lossily: ${descriptor.lossy}`,
    );
  }
}

function DescribeFields(
  declared: DeclaredTable,
  columns: Map<string, CatalogColumn>,
): Record<string, FieldSpec> {
  const fields: Record<string, FieldSpec> = {};
  for (const [name, spec] of Object.entries(declared.parsed.fields)) {
    const column = columns.get(name);
    if (!column) {
      throw MissingColumn(declared, name);
    }
    const native = Describe(
      name,
      spec.type,
      column,
      `${PathOf(declared)}.${name}`,
    );
    WarnLossy(declared, native);
    fields[name] = { ...spec, native };
  }
  return fields;
}

function ReportKeyless(declared: DeclaredTable): void {
  Logger.Info(
    `${NativeName(declared)} has no primary key and no unique index over NOT NULL columns usable as one, so the rows of '${PathOf(declared)}' answer no ${ID_COLUMN}: it can be queried, but not read by key`,
  );
}

function KeyFor(
  declared: DeclaredTable,
  relation: CatalogRelation,
  columns: Map<string, CatalogColumn>,
): ColumnDescriptor[] | undefined {
  const key = DescribeKeyColumns(relation.key, columns);
  if (key) {
    return key;
  }
  if (Object.hasOwn(declared.table.fields ?? {}, ID_COLUMN)) {
    throw KeylessAlias(declared);
  }
  ReportKeyless(declared);
  return undefined;
}

/** The columns a declared index names, with `_id` standing for the key's own columns. */
function IndexColumnNames(fields: string[], key: string[]): string[] {
  return fields.flatMap((field) => (field === ID_COLUMN ? key : [field]));
}

function Serves(served: string[], wanted: string[]): boolean {
  return wanted.every((column, position) => served[position] === column);
}

/**
 * Warns, once per registration, about each declared index no valid btree index of the database
 * leads with: the declaration creates nothing in external mode, so queries over it stay correct
 * and may be slow.
 */
function WarnUnservedIndexes(
  declared: DeclaredTable,
  relation: CatalogRelation,
): void {
  for (const [indexId, index] of Object.entries(declared.table.indexes ?? {})) {
    const wanted = IndexColumnNames(
      IndexFields(indexId, index),
      relation.key ?? [],
    );
    if (!relation.indexes.some((served) => Serves(served, wanted))) {
      Logger.Warn(
        `Index '${indexId}' on '${PathOf(declared)}' is declared, but no btree index of ${NativeName(declared)} leads with (${wanted.join(", ")}): queries by it stay correct, and may be slow`,
      );
    }
  }
}

async function DescribeTable(declared: DeclaredTable): Promise<TableShape> {
  const relation = await ReadDeclared(declared);
  const columns = ColumnsByName(relation);
  const fields = DescribeFields(declared, columns);
  const external: ExternalRelation = {
    schema: declared.schemaId,
    table: declared.tableId,
    key: KeyFor(declared, relation, columns),
  };
  WarnUnservedIndexes(declared, relation);
  return { fields, external };
}

/**
 * Builds an external schema's shapes from the catalog, with no DDL: every table is a relation that
 * already exists, under the very names the declaration uses, and every declared field is read as
 * its column through §2's matrix. A table, column or type the database cannot honour fails the
 * whole registration with a message naming it.
 */
export async function DescribeExternalSchema(
  schemaId: string,
  schema: SchemaDefinition,
  parsed: SchemaShape,
): Promise<SchemaShape> {
  const shapes: SchemaShape = {};
  for (const [tableId, table] of Object.entries(schema)) {
    shapes[tableId] = await DescribeTable({
      schemaId,
      tableId,
      table,
      parsed: parsed[tableId],
    });
  }
  return shapes;
}
