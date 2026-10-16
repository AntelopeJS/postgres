import { GetRuntimeInfo } from "@antelopejs/interface-core/runtime";
import type {
  CatalogInfo,
  Measure,
  ProfileRequest,
  ReferenceCheck,
  ReferenceMatch,
  RelationDescription,
  RelationProfile,
  RelationSummary,
  RowSample,
  SampleRequest,
} from "@antelopejs/interface-database-catalog";

import { GetOptions, IsExternal } from "../../config";
import {
  DescribeRow,
  ReadInfo,
  ReadNamedRelationRows,
  ReadRelationRows,
  RelationName,
  Summarize,
} from "../database/external-discovery";
import { Sequentially } from "../database/external-measures";
import { ProfileRelation } from "../database/external-profile";
import { CheckColumnReference } from "../database/external-reference";
import { SampleRelationRows } from "../database/external-rows";

const OWNED_REFUSAL =
  "the catalog describes a database an external instance was pointed at; this instance owns its tables";
const DEVELOPMENT_REFUSAL =
  "the catalog is a development tool: it answers under ajs project dev or run, or with catalog.enabled";

async function IsEnabled(): Promise<boolean> {
  const configured = GetOptions().catalog.enabled;
  return configured ?? (await GetRuntimeInfo()).dev;
}

/** Refuses every catalog call on an owned instance, and outside development unless enabled. */
async function Guard(): Promise<void> {
  if (!IsExternal()) {
    throw new Error(OWNED_REFUSAL);
  }
  if (!(await IsEnabled())) {
    throw new Error(DEVELOPMENT_REFUSAL);
  }
}

export async function Info(): Promise<CatalogInfo> {
  await Guard();
  return ReadInfo();
}

export async function ListRelations(
  schemas?: string[],
): Promise<RelationSummary[]> {
  await Guard();
  return Sequentially(await ReadRelationRows(schemas), Summarize);
}

export async function DescribeRelations(
  relations: string[],
): Promise<RelationDescription[]> {
  await Guard();
  const rows = await ReadNamedRelationRows(relations);
  const found = new Set(rows.map(RelationName));
  const missing = relations.filter((relation) => !found.has(relation));
  if (missing.length > 0) {
    throw new Error(
      `No relation ${missing.join(", ")} that the connected role can see`,
    );
  }
  return Sequentially(rows, DescribeRow);
}

export async function Profile(
  request: ProfileRequest,
): Promise<RelationProfile> {
  await Guard();
  return ProfileRelation(request);
}

export async function CheckReference(
  check: ReferenceCheck,
): Promise<Measure<ReferenceMatch>> {
  await Guard();
  return CheckColumnReference(check);
}

export async function SampleRows(request: SampleRequest): Promise<RowSample> {
  await Guard();
  return SampleRelationRows(request);
}
