import { has, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { pick, text } from "./json.ts";
import { answered, close, logs, open, ownedConfig, part, same, sees, server, SERVICE, sql, type Session } from "./session.ts";

const LAYOUT = `{ items: { fields: { name: "string", price: "number", sku: "string", tags: "string[]" }, indexes: { price: {}, name: { crossInstance: true }, sku: { unique: true }, tags: { multi: true } } } }`;

const OWNED_INDEXES = ["items_name", "items_name__g", "items_price", "items_sku", "items_tags"];

/** Waits, inside the container, until the schema holds `count` indexes besides its primary key: secondary indexes build in the background after registration. */
async function indexesBuilt(context: JourneyContext, schema: string, count: number): Promise<void> {
  const query = `SELECT count(*) FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname JOIN pg_index x ON x.indexrelid = c.oid WHERE i.schemaname = '${schema}' AND x.indisvalid AND NOT x.indisprimary`;
  const waited = await context.native("wait for the background index phase", SERVICE, [
    "sh",
    "-c",
    `for i in $(seq 150); do n=$(psql -U postgres -d verify -tAXc "${query}"); [ "$n" -ge ${String(count)} ] && exit 0; sleep 0.2; done; echo "$n"; exit 1`,
  ]);
  context.expect(waited.folder, [{ name: `the ${String(count)} declared indexes are built and valid`, pass: waited.exitCode === 0, detail: waited.stdout.trim() }], { critical: true });
}

export const storageLayout: Journey = {
  title: "a schema is a PostgreSQL schema whose tables lead their key and indexes with _instance, and each declared index kind becomes the documented index",
  entryPoint: "`new Schema(id, { table: { fields, indexes } })` and `createInstance` from a consumer module, read back with psql",
  async run(context) {
    const session = await open(context, ownedConfig(server(context)));
    const result = await session.run(
      "register the schema and write into two instances",
      `const schema = new Schema("verify-layout", ${LAYOUT});
await schema.createInstance("a").run();
await schema.createInstance("b").run();
await schema.instance("a").table("items").insert([{ _id: "i1", name: "lamp", price: 10, sku: "S1", tags: ["home"] }, { _id: "i2", name: "desk", price: 90, sku: "S2", tags: ["office"] }]).run();
await schema.instance("b").table("items").insert({ _id: "i1", name: "lamp", price: 12, sku: "S1", tags: ["home"] }).run();
return { instances: (await schema.listInstances().run()).sort() };`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [sees("listInstances answers both instances", part(result, "instances"), ["a", "b"])]);
    await indexesBuilt(context, "verify-layout", OWNED_INDEXES.length);
    const indexes = await sql(
      context,
      "read the indexes of the table",
      `SELECT json_object_agg(indexname, indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'verify-layout' AND tablename = 'items'`,
    );
    const defs = (name: string): string => text(pick(indexes.value, name));
    context.expect(indexes.folder, [
      same("the table holds the primary key and one index per declared index, the crossInstance twin included", Object.keys(indexes.value ?? {}).sort(), [...OWNED_INDEXES, "items_pkey"].sort()),
      has("the primary key is (_instance, _id)", defs("items_pkey"), /UNIQUE INDEX items_pkey .* \(_instance, _id\)/u),
      has("a declared index is a btree led by _instance", defs("items_price"), /USING btree \(_instance, price\)$/u),
      has("a crossInstance index is led by _instance", defs("items_name"), /USING btree \(_instance, name\)$/u),
      has("a crossInstance index has an unprefixed __g twin", defs("items_name__g"), /USING btree \(name\)$/u),
      has("a unique index is UNIQUE within the instance", defs("items_sku"), /^CREATE UNIQUE INDEX items_sku .*\(_instance, sku\)$/u),
      has("a multi index over a jsonb field is GIN on the column alone", defs("items_tags"), /USING gin \(tags\)$/u),
    ]);
    const registry = await sql(
      context,
      "read the instance registry",
      `SELECT json_agg(instance_id ORDER BY instance_id) FROM __antelope.instances WHERE schema_id = 'verify-layout'`,
    );
    context.expect(registry.folder, [same("__antelope.instances records each created instance", registry.value, ["a", "b"])]);
    await instances(session);
    await close(session);
  },
};

async function instances(session: Session): Promise<void> {
  const { context } = session;
  const result = await session.run(
    "write a duplicate key, read across instances and destroy one",
    `const schema = new Schema("verify-layout", ${LAYOUT});
const out = {};
try { await schema.instance("a").table("items").insert({ _id: "i3", name: "chair", sku: "S1" }).run(); out.duplicate = "stored"; } catch (error) { out.duplicate = error.name; }
out.crossCount = await schema.instance(db.CROSS_INSTANCE).table("items").count().run();
out.aCount = await schema.instance("a").table("items").count().run();
out.namedCarriesInstance = Object.hasOwn((await schema.instance("a").table("items").get("i1").run()) ?? {}, "_instance");
await schema.destroyInstance("b").run();
out.afterDestroy = (await schema.listInstances().run()).sort();
return out;`,
  );
  context.expect(result.folder, [answered(result)], { critical: true });
  context.expect(result.folder, [
    sees("a unique key taken in the same instance throws DuplicateKeyError", part(result, "duplicate"), "DuplicateKeyError"),
    sees("a CROSS_INSTANCE read sees the rows of every instance", part(result, "crossCount"), 3),
    sees("a scoped read sees only its instance", part(result, "aCount"), 2),
    sees("a document of a named instance carries _instance", part(result, "namedCarriesInstance"), true),
    sees("destroyInstance removes the instance", part(result, "afterDestroy"), ["a"]),
  ]);
  const rows = await sql(
    context,
    "read the rows left after destroyInstance",
    `SELECT json_build_object('instances', (SELECT json_agg(DISTINCT _instance) FROM "verify-layout".items), 'table', to_regclass('"verify-layout".items') IS NOT NULL)`,
  );
  context.expect(rows.folder, [same("destroyInstance deletes the instance's rows and keeps the table", rows.value, { instances: ["a"], table: true })]);
}

const V1 = `{ notes: { fields: { title: "string" }, indexes: {} } }`;
const V2 = `{ notes: { fields: { title: "string", rank: "number" }, indexes: {} } }`;
const V3 = `{ notes: { fields: { rank: "string" }, indexes: {} } }`;

async function register(context: JourneyContext, label: string, definition: string, migrations: string): Promise<{ session: Session; read: Awaited<ReturnType<Session["run"]>> }> {
  const session = await open(context, { ...ownedConfig(server(context)), migrations });
  const read = await session.run(
    label,
    `const schema = new Schema("verify-migrate", ${definition});
try { return { row: await schema.instance().table("notes").get("r1").run() }; } catch (error) { return { refused: String(error && error.message) }; }`,
  );
  context.expect(read.folder, [answered(read)], { critical: true });
  return { session, read };
}

function columns(context: JourneyContext, label: string): ReturnType<typeof sql> {
  return sql(
    context,
    label,
    `SELECT json_build_object('columns', (SELECT json_object_agg(column_name, data_type) FROM information_schema.columns WHERE table_schema = 'verify-migrate' AND table_name = 'notes' AND column_name IN ('title', 'rank')), 'row', (SELECT to_jsonb(n) - '_id' - '_instance' FROM "verify-migrate".notes n WHERE _id = 'r1'))`,
  );
}

export const migrations: Journey = {
  title: "a new field adds its column and moves stored values out of _extra, a changed type is refused under safe and altered under destructive, which also drops an undeclared column",
  entryPoint: "the schema a consumer module declares, changed between two runs of `ajs project dev`, with `migrations` in the module's config",
  async run(context) {
    const first = await open(context, ownedConfig(server(context)));
    const seeded = await first.run(
      "store a row with an undeclared field",
      `const schema = new Schema("verify-migrate", ${V1});
await schema.instance().table("notes").insert({ _id: "r1", title: "x", rank: 5 }).run();
return "stored";`,
    );
    context.expect(seeded.folder, [answered(seeded)], { critical: true });
    await close(first);

    const second = await register(context, "declare rank and read the row", V2, "safe");
    context.expect(second.read.folder, [sees("the row reads back with rank from its column", part(second.read, "row"), { _id: "r1", rank: 5, title: "x" })]);
    const added = await columns(context, "read the columns after declaring rank");
    context.expect(added.folder, [
      same("rank is a double precision column holding 5, and _extra no longer holds it", added.value, {
        columns: { rank: "double precision", title: "text" },
        row: { _extra: {}, rank: 5, title: "x" },
      }),
    ]);
    await close(second.session);

    const third = await register(context, "declare rank as a string under safe", V3, "safe");
    const said = `${text(pick(third.read.value, "refused"))}\n${await logs(third.session)}`;
    context.expect(third.read.folder, [
      has("safe refuses the changed type and names the column", said, /Column 'rank' on .* is double precision but the schema declares text; set migrations: "destructive" to alter it/u),
      { name: "no read of the refused schema answers", pass: pick(third.read.value, "row") === undefined, detail: JSON.stringify(third.read.value ?? null) },
    ]);
    await close(third.session);

    const fourth = await register(context, "declare rank as a string under destructive", V3, "destructive");
    context.expect(fourth.read.folder, [sees("the row reads back with rank as text", part(fourth.read, "row"), { _id: "r1", rank: "5" })]);
    const altered = await columns(context, "read the columns after the destructive migration");
    context.expect(altered.folder, [
      same("rank is now text and the undeclared title column is dropped", altered.value, { columns: { rank: "text" }, row: { _extra: {}, rank: "5" } }),
    ]);
    await close(fourth.session);
  },
};
