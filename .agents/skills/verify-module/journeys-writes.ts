import type { Journey } from "@antelopejs/tooling-configs/verify";

import { answered, close, open, ownedConfig, part, same, sees, server, sql } from "./session.ts";

const DEFINITION = `{ docs: { fields: { title: "string", n: "number", done: "boolean", at: "date", tags: "string[]", meta: "object" }, indexes: {} } }`;

export const insertValues: Journey = {
  title: "insert resolves to one id per document and stores each declared type in its column, an undeclared field in _extra and the instance in _instance",
  entryPoint: "`table.insert(document | documents)` from a consumer module, read back with psql",
  async run(context) {
    const session = await open(context, ownedConfig(server(context)));
    const result = await session.run(
      "insert documents",
      `const schema = new Schema("verify-writes", ${DEFINITION});
await schema.createInstance("a").run();
const docs = schema.instance("a").table("docs");
await docs.insert({ _id: "one", title: "First", n: 1.5, done: false, at: new Date("2024-03-01T10:00:00.000Z"), tags: ["x", "y"], meta: { deep: { level: 2 } }, loose: "kept" }).run();
const many = await docs.insert([{ title: "Second" }, { title: "Third", n: null }]).run();
const one = await docs.get("one").run();
return { manyCount: many.length, generated: many.every((id) => typeof id === "string" && id.length > 0), atIsDate: one.at instanceof Date, one };`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("an array insert resolves to one id per document", part(result, "manyCount"), 2),
      sees("generated ids are non-empty text", part(result, "generated"), true),
      sees("a date field reads back as a Date", part(result, "atIsDate"), true),
      sees("the document reads back whole, the undeclared field included", part(result, "one"), {
        _id: "one",
        _instance: "a",
        at: "2024-03-01T10:00:00.000Z",
        done: false,
        loose: "kept",
        meta: { deep: { level: 2 } },
        n: 1.5,
        tags: ["x", "y"],
        title: "First",
      }),
    ]);
    const columns = await sql(
      context,
      "read the columns of the stored table",
      `SELECT json_object_agg(column_name, data_type ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'verify-writes' AND table_name = 'docs'`,
    );
    context.expect(columns.folder, [
      same("each declared field is a column of its documented type, beside _id, _instance and _extra", columns.value, {
        _extra: "jsonb",
        _id: "text",
        _instance: "text",
        at: "timestamp with time zone",
        done: "boolean",
        meta: "jsonb",
        n: "double precision",
        tags: "jsonb",
        title: "text",
      }),
    ]);
    const row = await sql(
      context,
      "read the stored row",
      `SELECT json_build_object('instance', _instance, 'title', title, 'n', n, 'at', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), 'tags', tags, 'extra', _extra, 'count', (SELECT count(*) FROM "verify-writes".docs)) FROM "verify-writes".docs WHERE _id = 'one'`,
    );
    context.expect(row.folder, [
      same("psql reads the values the module wrote", row.value, {
        at: "2024-03-01T10:00:00",
        count: 3,
        extra: { loose: "kept" },
        instance: "a",
        n: 1.5,
        tags: ["x", "y"],
        title: "First",
      }),
    ]);
    await close(session);
  },
};

export const updateReplaceDelete: Journey = {
  title: "update merges into the stored row, replace swaps it whole, delete removes it, and a taken _id is a DuplicateKeyError",
  entryPoint: "`get(id).update/replace/delete()` and `insert` of a taken `_id` from a consumer module, read back with psql",
  async run(context) {
    const session = await open(context, ownedConfig(server(context)));
    const result = await session.run(
      "update, replace and delete rows",
      `const schema = new Schema("verify-change", ${DEFINITION});
const docs = schema.instance().table("docs");
await docs.insert([{ _id: "u", title: "old", n: 1, done: false }, { _id: "r", title: "old", n: 2, meta: { a: 1 } }, { _id: "d", title: "gone" }]).run();
const out = {};
out.updated = await docs.get("u").update({ title: "new", done: true }).run();
out.replaced = await docs.get("r").replace({ _id: "r", title: "replaced" }).run();
out.deleted = await docs.get("d").delete().run();
try { await docs.insert({ _id: "u", title: "again" }).run(); out.duplicate = "stored"; } catch (error) { out.duplicate = error.name; }
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("update answers the one row it changed", part(result, "updated"), 1),
      sees("replace answers the one row it changed", part(result, "replaced"), 1),
      sees("delete answers the one row it removed", part(result, "deleted"), 1),
      sees("inserting a taken _id throws DuplicateKeyError", part(result, "duplicate"), "DuplicateKeyError"),
    ]);
    const rows = await sql(
      context,
      "read the stored rows",
      `SELECT json_object_agg(_id, json_build_object('title', title, 'n', n, 'done', done, 'meta', meta) ORDER BY _id) FROM "verify-change".docs`,
    );
    context.expect(rows.folder, [
      same("update kept the fields it did not name, replace cleared them, and delete removed the row", rows.value, {
        r: { done: null, meta: null, n: null, title: "replaced" },
        u: { done: true, meta: null, n: 1, title: "new" },
      }),
    ]);
    await close(session);
  },
};
