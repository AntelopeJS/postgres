import assert from "node:assert";
import { DatabaseError } from "pg";
import { ValidateAtomicMutation } from "@antelopejs/interface-database/atomic";
import { IsQueryStage } from "@antelopejs/interface-database/common";
import type {
  AtomicMutation,
  AtomicRecord,
  AtomicMutationOutcome,
  AtomicDelete,
  AtomicUpdate,
} from "@antelopejs/interface-database";

import { DecodeValue } from "./value";
import { OPAQUE, TEXT } from "./types";
import { Query } from "../../connection";
import { UnifyOperands } from "./coerce";
import type { DecodingContext } from "./context";
import { JsonKey, Param, QualifiedColumn } from "./sql";
import { ID_AS_ASSERTION, SplitPayload } from "./payload";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
  RESERVED_COLUMNS,
} from "./utils";
import {
  Assignment,
  MergeExtra,
  RequireInstance,
  WRITE_ALIAS,
  type WriteCompiler,
  WriteTable,
  type WriteTarget,
  WriteRowSource,
} from "./writes-shared";
import { IsString } from "./guards";
import { ClassifyMember } from "./member";

export const ATOMIC_MUTATION = "atomicMutation";
const ATOMIC_ARGUMENT_COUNT = 2;

type Mutation = AtomicMutation<AtomicRecord>;
type RevisionMutation = AtomicDelete<AtomicRecord> | AtomicUpdate<AtomicRecord>;

function RevisionPredicate(
  target: WriteTarget,
  request: RevisionMutation,
  context: DecodingContext,
): string {
  const { revisionField, expectedRevision } = request;
  const declared = Object.hasOwn(target.origin.model.fields, revisionField)
    ? target.origin.model.fields[revisionField]
    : undefined;
  if (declared) {
    assert(
      IsString(expectedRevision),
      "Missing revision bootstrap is unsupported for declared PostgreSQL columns: absent and null share SQL NULL",
    );
    assert(
      declared.type.kind === "text",
      "A declared revision field must be text",
    );
    return `${QualifiedColumn(WRITE_ALIAS, declared.column)} = ${Param(context.params, expectedRevision, TEXT).sql}`;
  }
  const extra = QualifiedColumn(WRITE_ALIAS, EXTRA_COLUMN);
  if (!IsString(expectedRevision)) {
    return `NOT (${extra} ? ${Param(context.params, revisionField, TEXT).sql})`;
  }
  return `${JsonKey(extra, revisionField)} = ${Param(context.params, expectedRevision, OPAQUE).sql}`;
}

function AtomicAssignments(
  target: WriteTarget,
  request: Mutation,
  context: DecodingContext,
): string {
  assert(request.type === "update", "Expected an update mutation");
  const document = {
    ...request.patch,
    [request.revisionField]: request.nextRevision,
  };
  const view = ClassifyMember(document).document;
  assert(view, "A patch spread into a literal is a document");
  const split = SplitPayload(view, target.origin.model, context, {
    id: ID_AS_ASSERTION,
  });
  const assignments = split.members.map((member) =>
    Assignment(member.column, member.value.sql),
  );
  if (split.extra) {
    assignments.push(Assignment(EXTRA_COLUMN, MergeExtra(split.extra.sql)));
  }
  return assignments.join(", ");
}

function AtomicPredicate(
  target: WriteTarget,
  request: Mutation,
  context: DecodingContext,
): string {
  if (request.type !== "deleteIfEqual") {
    return RevisionPredicate(target, request, context);
  }
  const expected = DecodeValue(ClassifyMember(request.expectedValue), context);
  assert(expected, "Expected a constant equality value");
  const field = WriteRowSource(target.origin).field(request.field);
  const pair = UnifyOperands(field, expected);
  return `${pair.left.sql} = ${pair.right.sql}`;
}

export const AtomicWrite: WriteCompiler = (target, stage, context) => {
  assert(
    IsQueryStage(stage, ATOMIC_MUTATION) &&
      stage.options === undefined &&
      stage.args.length === ATOMIC_ARGUMENT_COUNT,
    "Atomic mutation requires exactly a key and request without options",
  );
  const instance = RequireInstance(target, stage);
  const [key, request] = stage.args;
  ValidateAtomicMutation(key, request, RESERVED_COLUMNS);
  const where = [
    `${QualifiedColumn(WRITE_ALIAS, INSTANCE_COLUMN)} = ${instance.sql}`,
    `${QualifiedColumn(WRITE_ALIAS, ID_COLUMN)} = ${Param(context.params, key, TEXT).sql}`,
    AtomicPredicate(target, request, context),
  ].join(" AND ");
  const table = WriteTable(target.origin);
  const command =
    request.type === "update"
      ? `UPDATE ${table} SET ${AtomicAssignments(target, request, context)}`
      : `DELETE FROM ${table}`;
  return {
    sql: `${command} WHERE ${where} RETURNING ${QualifiedColumn(WRITE_ALIAS, ID_COLUMN)}`,
  };
};

export async function ExecuteAtomicWrite(
  sql: string,
  params: unknown[],
  execute = Query,
): Promise<AtomicMutationOutcome> {
  try {
    const result = await execute(sql, params);
    return result.rows.length === 0 ? "not-applied" : "applied";
  } catch (error) {
    if (error instanceof DatabaseError && error.severity === "ERROR") {
      throw error;
    }
    return "unknown";
  }
}
