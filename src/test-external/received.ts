import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { GetPool } from "../connection";

/** How `pg-pool` reads a result: it hands `query` a callback rather than awaiting it. */
type Callback = (error: Error, result: QueryResult<QueryResultRow>) => void;

/** Every result set a client checked out of the module's pool receives while `work` runs, as JSON. */
export async function Received<T>(
  work: () => Promise<T>,
): Promise<{ answer: T; results: string[] }> {
  const results: string[] = [];
  const tapped = new Set<PoolClient>();
  const tap = (client: PoolClient) => {
    if (tapped.has(client)) {
      return;
    }
    tapped.add(client);
    const query = client.query.bind(client);
    Object.defineProperty(client, "query", {
      configurable: true,
      value: (text: string, values?: unknown[], callback?: Callback) => {
        if (callback) {
          query<QueryResultRow>(text, values ?? [], (error, result) => {
            results.push(JSON.stringify(result?.rows ?? []));
            callback(error, result);
          });
          return undefined;
        }
        return query<QueryResultRow>(text, values).then((result) => {
          results.push(JSON.stringify(result.rows));
          return result;
        });
      },
    });
  };
  const pool = GetPool();
  pool.on("acquire", tap);
  try {
    return { answer: await work(), results };
  } finally {
    pool.off("acquire", tap);
    for (const client of tapped) {
      Reflect.deleteProperty(client, "query");
    }
  }
}
