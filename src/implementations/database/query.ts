import type { QueryStage } from "./utils";

const UNIMPLEMENTED =
  "The PostgreSQL backend does not execute queries yet (scaffold only)";

export async function RunQuery(_stages: QueryStage[]): Promise<any> {
  throw new Error(UNIMPLEMENTED);
}

export async function ReadCursor(
  _reqId: number,
  _stages: QueryStage[],
): Promise<IteratorResult<any, void>> {
  throw new Error(UNIMPLEMENTED);
}

export async function CloseCursor(_reqId: number): Promise<void> {}
