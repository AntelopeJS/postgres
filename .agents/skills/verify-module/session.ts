import { interrupted, type App, type Check, type JourneyContext, type ServiceEndpoint } from "@antelopejs/tooling-configs/verify";

import { APP_SOURCE } from "./app-source.ts";
import { canonical, parseJson, pick, text, type Json } from "./json.ts";

export type ModuleConfig = NonNullable<
  NonNullable<Parameters<JourneyContext["fixture"]>[0]>["moduleConfig"]
>;

/** The name of the run's PostgreSQL service in `verify.config.ts`. */
export const SERVICE = "postgres";

/** The database every journey starts from empty: the service's `reset` drops and creates it before each journey. */
export const DATABASE = "verify";

/** The `psql` arguments that run statements in `database` as its owner and print bare rows. */
function psql(database: string): string[] {
  return ["psql", "-U", "postgres", "-d", database, "-tAX", "-v", "ON_ERROR_STOP=1", "-c"];
}

/** The URL of the run's PostgreSQL as an app reaches it from the host. */
export function urlOf(endpoint: ServiceEndpoint, user = "postgres", database = DATABASE): string {
  return `postgres://${user}@${endpoint.host}:${String(endpoint.port)}/${database}`;
}

/** The owned-mode config pointing at the run's PostgreSQL. */
export function ownedConfig(endpoint: ServiceEndpoint): ModuleConfig {
  return { url: urlOf(endpoint) };
}

/** The run's PostgreSQL service. */
export function server(context: JourneyContext): ServiceEndpoint {
  return context.service(SERVICE);
}

/** A check that two values are the same JSON once their keys are in order; an absent value equals only another absent one. */
export function same(name: string, actual: Json | undefined, expected: Json | undefined): Check {
  const got = actual === undefined ? "<absent>" : JSON.stringify(canonical(actual));
  const want = expected === undefined ? "<absent>" : JSON.stringify(canonical(expected));
  return { name, pass: got === want, detail: `expected ${want}, got ${got}` };
}

/** What a native statement printed, parsed as the JSON its last line holds. */
interface NativeResult {
  folder: string;
  value: Json | undefined;
  exitCode: number | null;
  stderr: string;
}

/** Runs one statement with `psql` inside the run's container, as the database's owner, and parses the JSON its last line prints; a statement that fails ends the journey, since its read-back would compare nothing. */
export async function sql(context: JourneyContext, name: string, statement: string, database = DATABASE): Promise<NativeResult> {
  const result = await context.native(name, SERVICE, [...psql(database), statement]);
  context.expect(result.folder, [{ name: "the read-back statement ran", pass: result.exitCode === 0, detail: result.stderr.slice(-300) }], { critical: true });
  const lines = result.stdout.trim().split("\n");
  return { folder: result.folder, value: parseJson(lines.at(-1) ?? ""), exitCode: result.exitCode, stderr: result.stderr };
}

/** Runs statements with `psql` as the database's owner and fails the journey when one fails: the seed a journey reads back. */
export async function seed(context: JourneyContext, name: string, statements: string, database = DATABASE): Promise<void> {
  const result = await context.native(name, SERVICE, [...psql(database), statements]);
  context.expect(result.folder, [{ name: "the seed statements ran", pass: result.exitCode === 0, detail: result.stderr.slice(-300) }], {
    critical: true,
  });
}

/** What a scenario body answered: the value it returned or the error it threw. */
export interface Answer {
  folder: string;
  ok: boolean;
  value: Json | undefined;
  error: { name: string; message: string; kind: string } | null;
}

export interface Session {
  context: JourneyContext;
  app: App;
  /** Runs a scenario body inside the consumer module, with `db`, `Schema`, `catalog` and `waitFor` in scope; the request aborts after the harness's 5 s, so a body must answer within it. */
  run(name: string, body: string): Promise<Answer>;
}

/** One key of the value a scenario returned, as the answer a {@link sees} check compares. */
export function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

/** A failing check when the scenario did not answer ok. */
export function answered(result: Answer): Check {
  return { name: "the scenario ran", pass: result.ok, detail: JSON.stringify(result.error) };
}

/** Compares what the consumer module saw with what the docs say it must be. */
export function sees(label: string, result: Answer, expected: Json): Check {
  return same(label, result.value, expected);
}

/** A path made of `parts`, joined the way the harness writes them. */
export function path(...parts: string[]): string {
  return parts.join("/");
}

async function freePort(context: JourneyContext): Promise<number> {
  const picked = await context.command("pick a free port", "node", [
    "-e",
    "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });",
  ]);
  return Number(picked.stdout.trim());
}

/** What the project printed so far, standard output and error. */
export async function logs(session: Session): Promise<string> {
  const out = await session.context.command("read the project's output", "cat", [path(session.app.folder, "stdout.txt")]);
  const err = await session.context.command("read the project's errors", "cat", [path(session.app.folder, "stderr.txt")]);
  return `${out.stdout}\n${err.stdout}`;
}

/** Writes a fixture project with the module configured as `moduleConfig` and a consumer module that runs scenario bodies; returns its folder. */
export async function prepare(context: JourneyContext, moduleConfig: ModuleConfig): Promise<string> {
  const project = context.fixture({ moduleConfig });
  const modules = {
    postgres: { source: { type: "local", path: context.repo }, config: moduleConfig },
    "verify-driver": { source: { type: "local", path: "./driver" } },
    "verify-app": { source: { type: "local", path: "./app" } },
  };
  context.edit("add the consumer module", path(project, "antelope.config.ts"), `export default ${JSON.stringify({ name: "verify-postgres", modules }, null, 2)};\n`);
  context.edit(
    "consumer package.json",
    path(project, "app", "package.json"),
    `${JSON.stringify({ name: "verify-app", version: "1.0.0", main: "index.js", antelopeJs: {} }, null, 2)}\n`,
  );
  context.edit("consumer source", path(project, "app", "index.js"), APP_SOURCE);
  const link = await context.command("link the repository's packages", "ln", ["-s", path(context.repo, "node_modules"), path(project, "app", "node_modules")]);
  context.expect(link.folder, [{ name: "the consumer resolves the repository's packages", pass: link.exitCode === 0, detail: link.stderr }], { critical: true });
  return project;
}

/** Starts `ajs project dev` on a {@link prepare}d project. */
export async function open(context: JourneyContext, moduleConfig: ModuleConfig): Promise<Session> {
  const project = await prepare(context, moduleConfig);
  const port = await freePort(context);
  const app = await context.dev("ajs project dev", project, { env: { VERIFY_APP_PORT: String(port) } });
  const base = `http://127.0.0.1:${String(port)}/`;
  return {
    context,
    app,
    async run(name, body) {
      const result = await context.http(name, base, { method: "POST", body });
      const error = pick(result.json, "error");
      const unanswered = result.error === null ? null : { name: "HttpError", message: result.error, kind: "" };
      return {
        folder: result.folder,
        ok: pick(result.json, "ok") === true,
        value: pick(result.json, "value"),
        error: error === undefined ? unanswered : { name: text(pick(error, "name")), message: text(pick(error, "message")), kind: text(pick(error, "kind")) },
      };
    },
  };
}

/** Stops the session's project with Ctrl+C and checks it exited as interrupted. */
export async function close(session: Session): Promise<void> {
  const stopped = await session.context.stop("SIGINT", session.app);
  session.context.expect(stopped.folder, [interrupted(stopped)]);
}
