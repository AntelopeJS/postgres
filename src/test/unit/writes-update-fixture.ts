import {
  CallerRoot,
  EVERY_ROW,
  IdentityPredicate,
  TABLE,
  UnchangedRows,
  Write,
  type WriteDocument,
  type Written,
} from "./pipeline-fixture";

export const UPDATE = `UPDATE ${TABLE} AS "w0" SET`;

export const EXISTING_EXTRA = `COALESCE("w0"."_extra", '{}'::jsonb)`;

export const KEY = "k";

export const NICKNAME = "z";

export const AGE = 40;

export const RAISE = 1;

/**
 * The whole statement an unselected `update(…)` compiles to, given its `SET` list.
 *
 * The wrap's alias is a parameter because it is whatever the alias counter had left: a `SET` list
 * that compiled a derived table of its own spent one before the target was built.
 */
export function Changes(assignments: string, alias?: string): string {
  return (
    `${UPDATE} ${assignments} WHERE ${IdentityPredicate(EVERY_ROW, alias)}` +
    ` AND ${UnchangedRows(assignments)}`
  );
}

export function Update(document: WriteDocument): Written {
  return Write(CallerRoot().get(KEY).update(document));
}
