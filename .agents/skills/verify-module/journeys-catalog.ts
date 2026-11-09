import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { CLIENT, externalConfig, READER, seedClient } from "./client.ts";
import { pick } from "./json.ts";
import { answered, close, open, ownedConfig, part, same, sees, server, sql } from "./session.ts";

const ATTEMPT = `const out = {};
const attempt = async (label, work) => { try { out[label] = { ok: true, value: await work() }; } catch (error) { out[label] = { ok: false, message: String(error.message) }; } };`;

export const catalogDescribe: Journey = {
  title: "the catalog of an external instance answers the database, its relations with keys and writes, their columns, a profile of aggregates and a capped sample, and writes nothing",
  entryPoint: "`Info`, `ListRelations`, `DescribeRelations`, `Profile` and `SampleRows` of @antelopejs/interface-database-catalog under `ajs project dev`",
  async run(context) {
    await seedClient(context);
    const session = await open(context, externalConfig(context));
    const result = await session.run(
      "describe the client's database",
      `const info = await catalog.Info();
const relations = await catalog.ListRelations(["sales"]);
const [accounts] = await catalog.DescribeRelations(["sales.accounts"]);
const profile = await catalog.Profile({ relation: "sales.accounts", columns: ["status", "score"] });
const sample = await catalog.SampleRows({ relation: "sales.accounts", columns: ["id", "name"], limit: 3 });
const status = profile.columns.find((c) => c.name === "status");
return {
  info: { engine: info.engine, database: info.database, role: info.role },
  relations: relations.map((r) => ({ name: r.name, kind: r.kind, key: r.key, writes: r.writes, unmappable: r.unmappable ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
  comment: accounts.comment,
  columns: accounts.columns.map((c) => c.name),
  statusCategories: status && status.categories && status.categories.status === "ok" ? status.categories.value.values.map((v) => [v.value, v.rows]).sort() : null,
  sample: { columns: sample.columns, rows: sample.rows.length, first: sample.rows[0] },
};`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("Info answers the engine, the database and the connected role", part(result, "info"), { database: CLIENT, engine: "postgresql", role: READER }),
      sees("ListRelations answers each relation with its kind, key and what the account may write", part(result, "relations"), [
        { key: { columns: ["id"], source: "primary" }, kind: "table", name: "accounts", unmappable: null, writes: { delete: true, insert: true, update: true } },
        { key: null, kind: "view", name: "active_accounts", unmappable: null, writes: { delete: false, insert: false, update: false } },
        { key: { columns: ["id"], source: "primary" }, kind: "table", name: "audit", unmappable: null, writes: { delete: false, insert: false, update: false } },
      ]),
      sees("DescribeRelations answers the table comment", part(result, "comment"), "Customer accounts"),
      sees("DescribeRelations answers every column", part(result, "columns"), ["id", "name", "status", "score", "created_at"]),
      sees("a profile names each category of a column with few distinct values, with its row count", part(result, "statusCategories"), [
        ["active", 10],
        ["churned", 10],
        ["lead", 10],
      ]),
      sees("SampleRows answers the requested columns and at most the requested rows, each value as text", part(result, "sample"), {
        columns: ["id", "name"],
        first: [
          { text: "1", truncated: false },
          { text: "Account 1", truncated: false },
        ],
        rows: 3,
      }),
    ]);
    const untouched = await sql(
      context,
      "read the client's database after the catalog calls",
      `SELECT json_build_object('rows', (SELECT count(*) FROM sales.accounts), 'installed', (SELECT count(*) FROM pg_namespace WHERE nspname = '__antelope'))`,
      CLIENT,
    );
    context.expect(untouched.folder, [same("the catalog wrote nothing to the client's database", untouched.value, { installed: 0, rows: 30 })]);
    await close(session);
  },
};

export const catalogRefused: Journey = {
  title: "an owned instance refuses the catalog, an external instance with catalog.enabled false refuses it, and an external instance whose server is down still starts in development and says why",
  entryPoint: "`catalog.Info()` from a consumer module against an owned instance, an external one with `catalog: { enabled: false }`, and an external one whose `url` does not answer",
  async run(context) {
    await seedClient(context);
    const probe = `${ATTEMPT}
await attempt("info", () => catalog.Info());
await attempt("query", () => new Schema("sales", { audit: { fields: { note: "string" }, indexes: {} } }).instance().table("audit").count().run());
return out;`;
    const owned = await open(context, ownedConfig(server(context)));
    const ownedResult = await owned.run("call the catalog of an owned instance", probe);
    context.expect(ownedResult.folder, [
      answered(ownedResult),
      has("an owned instance refuses the catalog", JSON.stringify(pick(ownedResult.value, "info") ?? null), /this instance owns its tables/u),
    ]);
    await close(owned);
    const disabled = await open(context, externalConfig(context, { catalog: { enabled: false } }));
    const disabledResult = await disabled.run("call the catalog with catalog.enabled false", probe);
    context.expect(disabledResult.folder, [
      answered(disabledResult),
      has("catalog.enabled false refuses the catalog under ajs project dev", JSON.stringify(pick(disabledResult.value, "info") ?? null), /the catalog is a development tool/u),
      same("the database interface still answers", pick(disabledResult.value, "query", "value"), 1),
    ]);
    await close(disabled);
    const down = await open(context, { mode: "external", url: `postgres://${READER}@127.0.0.1:1/${CLIENT}` });
    const downResult = await down.run("call the catalog and a query with a url that does not answer", probe);
    context.expect(downResult.folder, [
      answered(downResult),
      has("the catalog refuses with the reason it has no connection", JSON.stringify(pick(downResult.value, "info") ?? null), /PostgreSQL adapter is not connected: the server is not answering at 127\.0\.0\.1:1 \(ECONNREFUSED\)/u),
      has("a query refuses with the same reason", JSON.stringify(pick(downResult.value, "query") ?? null), /PostgreSQL adapter is not connected: the server is not answering/u),
    ]);
    await close(down);
  },
};
