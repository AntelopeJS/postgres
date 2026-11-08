import type { Journey, JourneyContext } from "@antelopejs/tooling-configs/verify";

import { answered, close, open, ownedConfig, part, same, sees, seed, server, SERVICE, sql } from "./session.ts";

const DOCS = `new Schema("verify-feeds", { docs: { fields: { title: "string", price: "number" }, indexes: {} } })`;

/** Waits, inside the container, until watching the table has installed its triggers, so the writes after it reach the log the feeds read. */
async function triggersInstalled(context: JourneyContext): Promise<void> {
  const query = `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'verify-feeds' AND c.relname = 'docs' AND NOT t.tgisinternal`;
  const waited = await context.native("wait for the feed's triggers", SERVICE, [
    "sh",
    "-c",
    `for i in $(seq 100); do n=$(psql -U postgres -d verify -tAXc "${query}"); [ "$n" -gt 0 ] && exit 0; sleep 0.1; done; exit 1`,
  ]);
  context.expect(waited.folder, [{ name: "watching the table installed its triggers", pass: waited.exitCode === 0, detail: waited.stdout.trim() }], { critical: true });
}

export const changeFeeds: Journey = {
  title: "a feed delivers added, modified and removed events in order with the documented oldValue and newValue, a write made with psql included, and a filtered feed shows a row leaving its filter",
  entryPoint: "`table.changes()` and `table.filter(...).changes()` iterated by a consumer module while it and psql write",
  async run(context) {
    const session = await open(context, ownedConfig(server(context)));
    const opened = await session.run(
      "open two feeds",
      `const docs = ${DOCS}.instance().table("docs");
await docs.insert({ _id: "seed", title: "seed", price: 1 }).run();
globalThis.verifyFeeds = { all: [], cheap: [], errors: [] };
const shape = (c) => ({ type: c.changeType, hasOld: Object.hasOwn(c, "oldValue"), hasNew: Object.hasOwn(c, "newValue"), old: c.oldValue ? c.oldValue.title : null, new: c.newValue ? c.newValue.title : null });
const follow = async (feed, into) => { for await (const c of feed) if ((c.newValue ?? c.oldValue)._id !== "seed") into.push(shape(c)); };
follow(docs.changes(), globalThis.verifyFeeds.all).catch((e) => globalThis.verifyFeeds.errors.push(String(e && e.message)));
follow(docs.filter((d) => d.key("price").lt(100)).changes(), globalThis.verifyFeeds.cheap).catch((e) => globalThis.verifyFeeds.errors.push(String(e && e.message)));
return "opened";`,
    );
    context.expect(opened.folder, [answered(opened)], { critical: true });
    await triggersInstalled(context);
    const written = await session.run(
      "write through the module",
      `const docs = ${DOCS}.instance().table("docs");
await waitFor(500);
await docs.insert({ _id: "a", title: "added", price: 10 }).run();
await docs.get("a").update({ title: "modified" }).run();
await docs.get("a").update({ price: 500 }).run();
await docs.get("a").delete().run();
return "written";`,
    );
    context.expect(written.folder, [answered(written)], { critical: true });
    await seed(context, "write a row with psql while the feeds are open", `INSERT INTO "verify-feeds".docs (_id, title, price) VALUES ('ext', 'from psql', 5)`);
    const read = await session.run(
      "read what the feeds delivered",
      `const feeds = globalThis.verifyFeeds;
for (let i = 0; i < 40 && (feeds.all.length < 5 || feeds.cheap.length < 4) && feeds.errors.length === 0; i++) await waitFor(100);
return feeds;`,
    );
    context.expect(read.folder, [answered(read)], { critical: true });
    context.expect(read.folder, [
      sees("no feed ended with an error", part(read, "errors"), []),
      sees("the feed delivers every write in order, the psql one included, with oldValue absent on added and newValue absent on removed", part(read, "all"), [
        { hasNew: true, hasOld: false, new: "added", old: null, type: "added" },
        { hasNew: true, hasOld: true, new: "modified", old: "added", type: "modified" },
        { hasNew: true, hasOld: true, new: "modified", old: "modified", type: "modified" },
        { hasNew: false, hasOld: true, new: null, old: "modified", type: "removed" },
        { hasNew: true, hasOld: false, new: "from psql", old: null, type: "added" },
      ]),
      sees("the filtered feed shows the row leaving the filter as modified and then nothing for the removal outside it", part(read, "cheap"), [
        { hasNew: true, hasOld: false, new: "added", old: null, type: "added" },
        { hasNew: true, hasOld: true, new: "modified", old: "added", type: "modified" },
        { hasNew: true, hasOld: true, new: "modified", old: "modified", type: "modified" },
        { hasNew: true, hasOld: false, new: "from psql", old: null, type: "added" },
      ]),
    ]);
    const log = await sql(
      context,
      "read the change log and its triggers",
      `SELECT json_build_object('log', to_regclass('__antelope.changes') IS NOT NULL, 'triggers', (SELECT count(*) > 0 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'verify-feeds' AND c.relname = 'docs' AND NOT t.tgisinternal))`,
    );
    context.expect(log.folder, [same("watching the table installed its triggers and the __antelope.changes log", log.value, { log: true, triggers: true })]);
    await close(session);
  },
};
