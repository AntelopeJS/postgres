import { randomBytes } from "node:crypto";

import type { ProbeAnswer } from "@antelopejs/interface-database-catalog";
import { expect } from "chai";
import { Client } from "pg";

import { probe } from "../probe";

export const TIMEOUT_MS = 2000;

const SECRET = randomBytes(6).toString("hex");

export const ABORTED_ANSWER = {
  outcome: "unreachable",
  message: "The probe was aborted.",
};

/** The logins the probe suites sign in as, each named for what it was granted. */
export const LOGIN = {
  reader: "probe_reader",
  writer: "probe_writer",
  updater: "probe_updater",
  deleter: "probe_deleter",
  columns: "probe_columns",
  blind: "probe_blind",
  unseen: "probe_unseen",
  grantee: "probe@grantee",
  trapped: "probe_trapped",
} as const;

export const NO_LOGIN = "probe_nologin";

export const LOCKED_DATABASE = "probe_locked";

const READERS_GROUP = "probe_readers";
const TEAM_GROUP = "probe_team";
const TRAP_SCHEMA = "probe_trap";

/** A schema whose `has_any_column_privilege` writes a row, for a URL that puts it on the path. */
export const SCRIBBLE_SCHEMA = "probe_scribble";
const GROUPS = [READERS_GROUP, TEAM_GROUP];
const ROLES = [...Object.values(LOGIN), NO_LOGIN, ...GROUPS];

function Quoted(role: string): string {
  return `"${role}"`;
}

/** Drops whatever an earlier run left, so a run killed midway does not wedge the next one. */
const TEARDOWN = [
  `DROP DATABASE IF EXISTS ${LOCKED_DATABASE}`,
  `DROP SCHEMA IF EXISTS ${TRAP_SCHEMA} CASCADE`,
  `DROP SCHEMA IF EXISTS ${SCRIBBLE_SCHEMA} CASCADE`,
  `DO $$ DECLARE role text; BEGIN
     FOREACH role IN ARRAY ARRAY[${ROLES.map((role) => `'${role}'`).join(", ")}] LOOP
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
         EXECUTE format('DROP OWNED BY %I', role);
         EXECUTE format('DROP ROLE %I', role);
       END IF;
     END LOOP;
   END $$`,
];

/** Grants that make each login what it is named for; the trapped one fails its relation listing. */
const SETUP = [
  ...TEARDOWN,
  ...Object.values(LOGIN).map(
    (role) => `CREATE ROLE ${Quoted(role)} LOGIN PASSWORD '${SECRET}'`,
  ),
  `CREATE ROLE ${NO_LOGIN} NOLOGIN PASSWORD '${SECRET}'`,
  ...GROUPS.map((role) => `CREATE ROLE ${role} NOLOGIN`),
  `GRANT USAGE ON SCHEMA sales TO ${[LOGIN.reader, LOGIN.writer, LOGIN.updater, LOGIN.deleter, LOGIN.columns, LOGIN.blind, LOGIN.trapped, READERS_GROUP].join(", ")}`,
  `GRANT SELECT ON sales.countries TO ${LOGIN.reader}, ${LOGIN.trapped}, ${READERS_GROUP}`,
  `GRANT SELECT, INSERT ON sales.countries TO ${LOGIN.writer}`,
  `GRANT UPDATE ON sales.countries TO ${LOGIN.updater}`,
  `GRANT DELETE ON sales.countries TO ${LOGIN.deleter}`,
  `GRANT SELECT (code) ON sales.countries TO ${LOGIN.columns}`,
  `GRANT ${READERS_GROUP} TO ${TEAM_GROUP}`,
  `GRANT ${TEAM_GROUP} TO ${Quoted(LOGIN.grantee)}`,
  `CREATE SCHEMA ${TRAP_SCHEMA}`,
  `CREATE FUNCTION ${TRAP_SCHEMA}.has_any_column_privilege(oid, text) RETURNS boolean
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the listing is refused'; END $$`,
  `GRANT USAGE ON SCHEMA ${TRAP_SCHEMA} TO ${LOGIN.trapped}`,
  `ALTER ROLE ${LOGIN.trapped} SET search_path = ${TRAP_SCHEMA}, pg_catalog`,
  `CREATE SCHEMA ${SCRIBBLE_SCHEMA}`,
  `CREATE TABLE ${SCRIBBLE_SCHEMA}.marks (n int)`,
  `CREATE FUNCTION ${SCRIBBLE_SCHEMA}.has_any_column_privilege(oid, text) RETURNS boolean
    LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${SCRIBBLE_SCHEMA}.marks VALUES (1); RETURN true; END $$`,
  `GRANT USAGE ON SCHEMA ${SCRIBBLE_SCHEMA} TO ${LOGIN.writer}`,
  `GRANT INSERT ON ${SCRIBBLE_SCHEMA}.marks TO ${LOGIN.writer}`,
  `CREATE DATABASE ${LOCKED_DATABASE}`,
  `REVOKE CONNECT ON DATABASE ${LOCKED_DATABASE} FROM PUBLIC`,
];

function OwnerUrl(): string {
  const url = process.env.PG_TEST_CLIENT_OWNER_URL;
  if (!url) {
    throw new Error("PG_TEST_CLIENT_OWNER_URL is set by the test setup");
  }
  return url;
}

async function RunAsOwner(statements: readonly string[]): Promise<void> {
  const client = new Client({ connectionString: OwnerUrl() });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

/** How many rows `relation` holds, counted by the client database's owner. */
export async function CountAsOwner(relation: string): Promise<number> {
  const client = new Client({ connectionString: OwnerUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${relation}`,
    );
    return rows[0].n;
  } finally {
    await client.end();
  }
}

/** Runs `check` with the environment variables `values` set, then puts each one back. */
export async function WithEnvironment(
  values: Readonly<Record<string, string>>,
  check: () => Promise<void>,
): Promise<void> {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    await check();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Creates the probe suites' logins and database before a suite, and drops them after it. */
export function WithProbeLogins(): void {
  before(() => RunAsOwner(SETUP));
  after(() => RunAsOwner(TEARDOWN));
}

export function Altered(url: string, change: (target: URL) => void): string {
  const target = new URL(url);
  change(target);
  return target.toString();
}

export function LoginUrl(role: string, password = SECRET): string {
  return Altered(OwnerUrl(), (target) => {
    target.username = role;
    target.password = password;
  });
}

export function OnPort(url: string, port: number, host = "127.0.0.1"): string {
  return Altered(url, (target) => {
    target.hostname = host;
    target.port = String(port);
  });
}

export function ServerPort(): number {
  return Number(new URL(OwnerUrl()).port);
}

export function Probe(
  url: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProbeAnswer> {
  return probe({ url, timeoutMs: TIMEOUT_MS, signal });
}

export function SignedIn(answer: ProbeAnswer) {
  expect(answer.outcome).to.equal("signed-in");
  if (answer.outcome !== "signed-in") {
    throw new Error("unreachable after the expectation");
  }
  return answer;
}
