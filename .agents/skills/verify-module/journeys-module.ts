import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { parseJson, pick } from "./json.ts";
import { answered, close, open, path, same, sees, server, sql, urlOf, type ModuleConfig } from "./session.ts";

/** A server nothing answers on, so a refusal that regressed past validation can never reach a developer's local database. */
const DEAD = "postgres://postgres@127.0.0.1:1/verify";

const REFUSALS: [string, ModuleConfig, RegExp][] = [
  ["an unknown mode", { mode: "shared", url: DEAD }, /mode must be one of owned, external, received shared/u],
  ["a cursorBatchSize of zero", { url: DEAD, cursorBatchSize: 0 }, /cursorBatchSize must be a positive safe integer, received 0/u],
  ["a fractional cursorBatchSize", { url: DEAD, cursorBatchSize: 1.5 }, /cursorBatchSize must be a positive safe integer, received 1\.5/u],
  ["a negative changeRetentionMs", { url: DEAD, changeRetentionMs: -5 }, /changeRetentionMs must be a positive safe integer, received -5/u],
  ["an external instance without a url", { mode: "external" }, /mode "external" needs a non-empty config\.url/u],
  [
    "an external instance with owned-only options",
    { mode: "external", url: "postgres://postgres@127.0.0.1:1/client", schemaPrefix: "app_", migrations: "destructive" },
    /schemaPrefix, migrations cannot be set with mode "external"/u,
  ],
  ["an owned instance whose server does not answer", { url: DEAD }, /connect ECONNREFUSED 127\.0\.0\.1:1/u],
];

export const configRefused: Journey = {
  title: "the module refuses to start on a config docs/configuration.md and docs/external-mode.md exclude, and says why",
  entryPoint: "`ajs project dev` with an unusable `config` in antelope.config.ts",
  async run(context) {
    const cli = path(context.repo, "node_modules/@antelopejs/core/dist/core/cli/index.js");
    for (const [label, config, message] of REFUSALS) {
      const project = context.fixture({ moduleConfig: config });
      const started = await context.command(`ajs project dev with ${label}`, "node", [cli, "project", "dev"], { cwd: project, timeoutMs: 60_000 });
      context.expect(started.folder, [
        {
          name: `the project exited on its own with a failure code with ${label}`,
          pass: started.exitCode !== null && started.exitCode !== 0 && started.signal === null,
          detail: `exit ${String(started.exitCode)}, signal ${String(started.signal)}`,
        },
        has(`the refusal says why (${label})`, started.stdout + started.stderr, message),
      ]);
    }
  },
};

const ROUND_TRIP = `const schema = new Schema("verify-config", { notes: { fields: { title: "string" }, indexes: {} } });
const notes = schema.instance().table("notes");
await notes.insert({ _id: "n1", title: "stored" }).run();
return (await notes.get("n1").run()).title;`;

export const configOptions: Journey = {
  title: "the default config points at localhost, a pool option the url does not set takes effect, and schemaPrefix prefixes every generated schema",
  entryPoint: "`url`, `pool` and `schemaPrefix` in the module's config in antelope.config.ts",
  async run(context) {
    const manifest = await context.command("read the module's package.json, where the default configuration `ajs project modules add` writes lives", "cat", [
      path(context.repo, "package.json"),
    ]);
    context.expect(manifest.folder, [
      same("the default configuration is the documented url in safe mode", pick(parseJson(manifest.stdout), "antelopeJs", "defaultConfig"), {
        migrations: "safe",
        url: "postgres://postgres@localhost:5432/antelopejs",
      }),
    ]);
    const merged = await open(context, { url: urlOf(server(context)), pool: { application_name: "verify-pool" }, schemaPrefix: "app_" });
    const result = await merged.run("round trip with a pool option and a schemaPrefix", ROUND_TRIP);
    context.expect(result.folder, [answered(result), sees("the document written through the module reads back", result, "stored")]);
    const stored = await sql(context, "read the prefixed schema", `SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname LIKE '%verify-config'`);
    context.expect(stored.folder, [same("the schema id is stored under the prefix, and only there", stored.value, ["app_verify-config"])]);
    const sessions = await sql(
      context,
      "read the application name of the module's connections",
      `SELECT json_agg(DISTINCT application_name) FROM pg_stat_activity WHERE datname = 'verify' AND usename = 'postgres' AND pid <> pg_backend_pid()`,
    );
    context.expect(sessions.folder, [same("the module's connections carry pool.application_name", sessions.value, ["verify-pool"])]);
    await close(merged);
  },
};
