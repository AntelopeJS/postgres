import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { CLIENT, externalConfig, SALES, seedClient } from "./client.ts";
import { pick, text } from "./json.ts";
import { answered, close, logs, open, part, same, sees, sql } from "./session.ts";

const ATTEMPT = `const attempt = async (label, work) => { try { await work(); out[label] = { ok: true }; } catch (error) { out[label] = { name: error.name, kind: error.kind ?? null, message: String(error.message) }; } };`;

export const externalReadWrite: Journey = {
  title: "an external instance reads the client's rows under their own names with _id as the key's text, writes only declared fields into granted tables, and installs nothing in the client's database",
  entryPoint: "`mode: \"external\"` with a reader account's `url`, and a schema declared with the database's own names, from a consumer module",
  async run(context) {
    await seedClient(context);
    const session = await open(context, externalConfig(context));
    const result = await session.run(
      "read and write the client's accounts",
      `const sales = ${SALES};
const accounts = sales.instance().table("accounts");
const out = {};
${ATTEMPT}
const first = await accounts.get("1").run();
out.first = { _id: first._id, id: first.id, name: first.name, status: first.status, created_at: first.created_at };
out.count = await accounts.count().run();
out.active = await accounts.filter((a) => a.key("status").eq("active")).count().run();
out.viewCount = await sales.instance().table("active_accounts").count().run();
out.inserted = await accounts.insert({ name: "Inserted", score: 3 }).run();
out.updated = await accounts.get("2").update({ status: "churned", score: 9 }).run();
out.unchanged = await accounts.get("2").update({ status: "churned" }).run();
await attempt("undeclared", () => accounts.insert({ name: "x", other: 1 }).run());
await attempt("tooLong", () => accounts.insert({ name: "x".repeat(30) }).run());
await attempt("unknownEnum", () => accounts.get("3").update({ status: "prospect" }).run());
await attempt("identity", () => accounts.insert({ id: "99", name: "y" }).run());
await attempt("forbidden", () => sales.instance().table("audit").insert({ id: 9, note: "n" }).run());
await attempt("changes", () => accounts.changes()[Symbol.asyncIterator]().next());
await attempt("createInstance", () => sales.createInstance("x").run());
await attempt("keyless", () => sales.instance().table("active_accounts").get("1").run());
out.instances = await sales.listInstances().run();
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const error = (label: string): string => text(pick(result.value, label, "message"));
    context.expect(result.folder, [
      sees("a row reads under its own column names, _id the key as text and a bigint declared string as its exact text", part(result, "first"), {
        _id: "1",
        created_at: "2026-01-01T00:00:00.000Z",
        id: "1",
        name: "Account 1",
        status: "active",
      }),
      sees("count reads every row of the table", part(result, "count"), 30),
      sees("an enum compares as its label", part(result, "active"), 10),
      sees("a view reads without a key", part(result, "viewCount"), 10),
      sees("insert answers the key the database generated", part(result, "inserted"), ["31"]),
      sees("an update that changes the row answers 1", part(result, "updated"), 1),
      sees("an update that changes nothing answers 0", part(result, "unchanged"), 0),
      has("a payload key that is not a declared field is refused by name", error("undeclared"), /Payload key 'other' is not a field of 'sales\.accounts'/u),
      has("a string too long for varchar(20) is refused before the write, naming the field", error("tooLong"), /sales\.accounts\.name/u),
      has("an unknown enum label is refused before the write, naming the field", error("unknownEnum"), /sales\.accounts\.status/u),
      has("insert refuses a value for an identity column the database fills", error("identity"), /Field 'sales\.accounts\.id' cannot be given a value/u),
      same("a write to a table the account was not granted is an ExternalWriteError of kind forbidden", pick(result.value, "forbidden", "kind"), "forbidden"),
      has("changes() is refused", error("changes"), /changes\(\) needs the adapter's change log/u),
      has("createInstance is refused", error("createInstance"), /The 'createInstance' stage manages instances/u),
      has("get on a relation without a key is refused", error("keyless"), /has no primary key and no unique index over NOT NULL columns/u),
      sees("listInstances answers an empty list", part(result, "instances"), []),
    ]);
    const stored = await sql(
      context,
      "read the client's database as its owner",
      `SELECT json_build_object(
  'inserted', (SELECT json_build_object('name', name, 'status', status, 'score', score) FROM sales.accounts WHERE id = 31),
  'updated', (SELECT json_build_object('status', status, 'score', score) FROM sales.accounts WHERE id = 2),
  'rows', (SELECT count(*) FROM sales.accounts),
  'audit', (SELECT json_agg(note) FROM sales.audit),
  'installed', (SELECT json_agg(nspname) FROM pg_namespace WHERE nspname = '__antelope'),
  'triggers', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal))`,
      CLIENT,
    );
    context.expect(stored.folder, [
      same("psql reads the inserted and updated rows, and nothing the refused writes tried", stored.value, {
        audit: ["kept"],
        inserted: { name: "Inserted", score: 3, status: "lead" },
        installed: null,
        rows: 31,
        triggers: 0,
        updated: { score: 9, status: "churned" },
      }),
    ]);
    await close(session);
  },
};

export const externalRegistration: Journey = {
  title: "registration of an external schema fails, naming what is missing, when a declared column does not exist, and every query on that schema fails",
  entryPoint: "a schema declared with a column the client's table lacks, under `mode: \"external\"`",
  async run(context) {
    await seedClient(context);
    const session = await open(context, externalConfig(context));
    const refused = await session.run(
      "declare a missing column and query",
      `const sales = new Schema("sales", { accounts: { fields: { name: "string", nickname: "string" }, indexes: {} } });
try { return { count: await sales.instance().table("accounts").count().run() }; } catch (error) { return { refused: String(error && error.message) }; }`,
    );
    context.expect(refused.folder, [answered(refused)], { critical: true });
    const said = `${text(pick(refused.value, "refused"))}\n${await logs(session)}`;
    context.expect(refused.folder, [
      has("the refusal names the field and the column", said, /Field 'sales\.accounts\.nickname' reads column "nickname", which .* does not have/u),
      { name: "no query on the refused schema answers", pass: pick(refused.value, "count") === undefined, detail: JSON.stringify(refused.value ?? null) },
    ]);
    await close(session);
  },
};
