import type { QueryStage } from "@antelopejs/interface-database/common";

import { WhileConfigured } from "./spec-fixture";
import type { TableOrigin } from "../../implementations/database/relation";
import {
  CloseOneFeed,
  type FeedEnvironment,
  type FeedReader,
  type LoggedEvent,
  ReadFeedEvent,
} from "../../implementations/database/feeds";

/**
 * A feed that never opens against a live schema, driven entirely through the reader seam.
 *
 * These `reqId`s are negative because the interface's own counter starts at 0
 * and counts up, so a fixture using a positive id would collide with a lambda or a cursor the
 * process allocated for something else.
 */
let nextReqId = -1000;
export const NewReqId = () => nextReqId--;

export const SCHEMA_ID = "shop";
export const TABLE_ID = "orders";

export const EPOCH = new Date("2026-08-12T09:00:00.000Z");

export function Stages(...between: QueryStage[]): QueryStage[] {
  return [
    { stage: "schema", options: { id: SCHEMA_ID }, args: [] },
    { stage: "instance", options: { id: "default" }, args: [] },
    { stage: "table", options: { id: TABLE_ID }, args: [] },
    ...between,
    { stage: "changes", args: [] },
  ];
}

interface Answer {
  epoch?: Date;
  high_water?: string | null;
  scanned_to?: string | null;
  events?: LoggedEvent[];
}

interface Asked {
  sql: string;
  params: unknown[];
}

/**
 * A table with no declared fields, so every logged key reads out of the overflow document.
 *
 * `index` answers the name itself, which is `IndexFields`' own undeclared-field fallback — the
 * feed's selection stages resolve through it exactly as the read path does.
 */
const FIELDLESS: TableOrigin = {
  schemaId: SCHEMA_ID,
  tableId: TABLE_ID,
  model: { fields: {} },
  index: (name) => [name],
};

/** Answers each statement in turn, recording what it was asked; the last answer repeats. */
export function Reader(answers: Answer[]) {
  const asked: Asked[] = [];
  const read: FeedReader = (sql, params) => {
    asked.push({ sql, params });
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    return Promise.resolve({
      rows: [
        {
          epoch: answer.epoch ?? EPOCH,
          high_water: answer.high_water ?? null,
          scanned_to: answer.scanned_to ?? null,
          scanned_count: (answer.events ?? []).length,
          events: answer.events ?? [],
        },
      ],
    });
  };
  return {
    read: {
      read,
      install: () => Promise.resolve(),
      origin: () => FIELDLESS,
      listen: () => Promise.resolve(),
    },
    asked,
  };
}

/**
 * Runs a feed spec with *a* configuration in place for the whole of it.
 *
 * `WithOptions` cannot serve here: it restores synchronously, and every generated name a feed reads
 * — the physical schema and table it watches — is resolved one await later, inside the open.
 */
export function Feed<T>(body: (reqId: number) => Promise<T>) {
  const reqId = NewReqId();
  return WhileConfigured(() => body(reqId)).finally(() => CloseOneFeed(reqId));
}

/** Reads one event, with the environment supplied so nothing touches a pool. */
export function Step(
  reqId: number,
  read: FeedEnvironment,
  ...between: QueryStage[]
) {
  return ReadFeedEvent(reqId, Stages(...between), read);
}
