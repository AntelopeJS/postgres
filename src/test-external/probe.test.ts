import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ProbeAnswer,
  RelationSummary,
} from "@antelopejs/interface-database-catalog";
import { expect } from "chai";
import { Client } from "pg";

import { type CatalogOptions, GetOptions } from "../config";
import { Connect } from "../connection";
import { ListRelations } from "../implementations/catalog";
import { probe } from "../probe";
import {
  ClosedPort,
  type Relay,
  StartRelayIgnoringGoodbye,
  StartRelayTo,
  WatchClientSockets,
} from "./relays";

const run = promisify(execFile);

const TIMEOUT_MS = 2000;
const CLOSE_SETTLE_MS = 1000;
/** Shorter than the 250 ms grace, so only an abort that shuts at once passes. */
const ABORT_SETTLE_MS = 100;
const EXTERNAL = "external";
const SECRET = randomBytes(6).toString("hex");
const ABORTED_ANSWER = {
  outcome: "unreachable",
  message: "The probe was aborted.",
};

/** The first byte of a simple query message, PostgreSQL's Query. */
const QUERY_MESSAGE = 0x51;
/** The first byte of the message a client sends before it closes, PostgreSQL's Terminate. */
const TERMINATE_MESSAGE = 0x58;

const READER = "probe_reader";
const WRITER = "probe_writer";
const BLIND = "probe_blind";
const GRANTEE = "probe@grantee";
const READERS_GROUP = "probe_readers";
const TEAM_GROUP = "probe_team";
const LOGINS = [READER, WRITER, BLIND, GRANTEE];
const GROUPS = [READERS_GROUP, TEAM_GROUP];

function Quoted(role: string): string {
  return `"${role}"`;
}

const SETUP = [
  ...LOGINS.map(
    (role) => `CREATE ROLE ${Quoted(role)} LOGIN PASSWORD '${SECRET}'`,
  ),
  ...GROUPS.map((role) => `CREATE ROLE ${role} NOLOGIN`),
  `GRANT USAGE ON SCHEMA sales TO ${[READER, WRITER, BLIND, READERS_GROUP].join(", ")}`,
  `GRANT SELECT ON sales.countries TO ${READER}, ${READERS_GROUP}`,
  `GRANT SELECT, INSERT ON sales.countries TO ${WRITER}`,
  `GRANT ${READERS_GROUP} TO ${TEAM_GROUP}`,
  `GRANT ${TEAM_GROUP} TO ${Quoted(GRANTEE)}`,
];

const TEARDOWN = [...LOGINS, ...GROUPS].flatMap((role) => [
  `DROP OWNED BY ${Quoted(role)}`,
  `DROP ROLE ${Quoted(role)}`,
]);

interface Restorable {
  url: string;
  catalog: CatalogOptions;
}

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

function Altered(url: string, change: (target: URL) => void): string {
  const target = new URL(url);
  change(target);
  return target.toString();
}

function LoginUrl(role: string, password = SECRET): string {
  return Altered(OwnerUrl(), (target) => {
    target.username = role;
    target.password = password;
  });
}

function OnPort(url: string, port: number): string {
  return Altered(url, (target) => {
    target.hostname = "127.0.0.1";
    target.port = String(port);
  });
}

function ServerPort(): number {
  return Number(new URL(OwnerUrl()).port);
}

function Probe(url: string, signal = new AbortController().signal) {
  return probe({ url, timeoutMs: TIMEOUT_MS, signal });
}

/** What the catalog says the login may do, read through `ListRelations` on its own connection. */
async function CatalogAccess(url: string) {
  await Connect({ mode: EXTERNAL, url, catalog: { enabled: true } });
  const relations: RelationSummary[] = await ListRelations();
  return {
    canRead:
      relations.length === 0 ||
      relations.some((relation) => relation.unmappable === undefined),
    canWrite: relations.some(
      ({ writes }) => writes.insert || writes.update || writes.delete,
    ),
  };
}

function SignedIn(answer: ProbeAnswer) {
  expect(answer.outcome).to.equal("signed-in");
  if (answer.outcome !== "signed-in") {
    throw new Error("unreachable after the expectation");
  }
  return answer;
}

function AccessCases(original: () => Restorable) {
  const cases = [
    { role: READER, canRead: true, canWrite: false },
    { role: WRITER, canRead: true, canWrite: true },
    { role: GRANTEE, canRead: true, canWrite: false },
    { role: BLIND, canRead: false, canWrite: false },
  ];

  after(async () => {
    await Connect({ mode: EXTERNAL, ...original() });
  });

  for (const { role, canRead, canWrite } of cases) {
    it(`answers ${role} with the access the catalog gives it`, async () => {
      const url = LoginUrl(role);
      const answer = SignedIn(await Probe(url));
      expect(answer).to.include({ user: role, canRead, canWrite });
      expect(answer.latencyMs).to.be.at.least(1);
      expect({ canRead, canWrite }).to.deep.equal(await CatalogAccess(url));
    });
  }
}

function RefusalCases() {
  it("refuses a wrong password as credentials", async () => {
    const answer = await Probe(LoginUrl(READER, "not-the-password"));
    expect(answer).to.include({ outcome: "refused", refusal: "credentials" });
  });

  it("refuses a database the server does not have as database", async () => {
    const url = Altered(LoginUrl(READER), (target) => {
      target.pathname = "/antelopejs_missing";
    });
    expect(await Probe(url)).to.include({
      outcome: "refused",
      refusal: "database",
    });
  });

  it("answers a port nothing listens on as unreachable, within the timeout", async () => {
    const started = performance.now();
    const answer = await Probe(OnPort(LoginUrl(READER), await ClosedPort()));
    expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS);
    expect(answer.outcome).to.equal("unreachable");
  });
}

async function WithRelay(
  relay: Relay,
  check: (relay: Relay) => Promise<void>,
): Promise<void> {
  try {
    await check(relay);
  } finally {
    await relay.close();
  }
}

function ClosingCases() {
  it("closes its connection once it has answered", async () => {
    await WithRelay(await StartRelayTo(ServerPort()), async (relay) => {
      SignedIn(await Probe(OnPort(LoginUrl(READER), relay.port)));
      expect(await relay.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    });
  });

  it("shuts its socket when the server ignores the goodbye", async () => {
    const goodbye = (chunk: Buffer, fromClient: boolean) =>
      fromClient && chunk[0] === TERMINATE_MESSAGE;
    const relay = await StartRelayIgnoringGoodbye(ServerPort(), goodbye);
    const sockets = WatchClientSockets(relay.port);
    await WithRelay(relay, async () => {
      try {
        const url = OnPort(LoginUrl(READER), relay.port);
        const answer = SignedIn(await Probe(url));
        expect(answer).to.include({ user: READER, canRead: true });
        expect(await sockets.settle(CLOSE_SETTLE_MS)).to.deep.equal({
          opened: 1,
          open: 0,
        });
      } finally {
        sockets.stop();
      }
    });
  });

  it("answers unreachable and closes when the server stops answering after the sign-in", async () => {
    const stall = (chunk: Buffer, fromClient: boolean) =>
      fromClient && chunk[0] === QUERY_MESSAGE;
    await WithRelay(await StartRelayTo(ServerPort(), stall), async (relay) => {
      const answer = await Probe(OnPort(LoginUrl(READER), relay.port));
      expect(answer.outcome).to.equal("unreachable");
      expect(await relay.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    });
  });

  it("answers aborted at once and shuts its socket when the signal aborts", async () => {
    const controller = new AbortController();
    let abortedAt = 0;
    const stall = (chunk: Buffer, fromClient: boolean) => {
      const stalls = fromClient && chunk[0] === QUERY_MESSAGE;
      if (stalls && abortedAt === 0) {
        abortedAt = performance.now();
        controller.abort();
      }
      return stalls;
    };
    await WithRelay(await StartRelayTo(ServerPort(), stall), async (relay) => {
      const sockets = WatchClientSockets(relay.port);
      try {
        const url = OnPort(LoginUrl(READER), relay.port);
        const answer = await Probe(url, controller.signal);
        expect(performance.now() - abortedAt).to.be.lessThan(ABORT_SETTLE_MS);
        expect(answer).to.deep.equal(ABORTED_ANSWER);
        expect(await sockets.settle(ABORT_SETTLE_MS)).to.deep.equal({
          opened: 1,
          open: 0,
        });
      } finally {
        sockets.stop();
      }
    });
  });

  it("answers aborted and opens nothing when the signal has already aborted", async () => {
    await WithRelay(await StartRelayTo(ServerPort()), async (relay) => {
      const sockets = WatchClientSockets(relay.port);
      try {
        const url = OnPort(LoginUrl(READER), relay.port);
        const answer = await Probe(url, AbortSignal.abort());
        expect(answer).to.deep.equal(ABORTED_ANSWER);
        expect(await sockets.settle(ABORT_SETTLE_MS)).to.deep.equal({
          opened: 0,
          open: 0,
        });
      } finally {
        sockets.stop();
      }
    });
  });
}

/** Blocks every `@antelopejs/` package, requires the built probe and prints its answer. */
const PLAIN_NODE_SCRIPT = `
const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@antelopejs/")) throw new Error("required " + request);
  return resolve.call(this, request, ...rest);
};
const { probe } = require(process.argv[1]);
probe({ url: process.argv[2], timeoutMs: 5000, signal: new AbortController().signal })
  .then((answer) => process.stdout.write(JSON.stringify(answer)));
`;

describe("the connection probe", function () {
  this.timeout(60_000);
  let original: Restorable;

  before(async () => {
    const { url, catalog } = GetOptions();
    original = { url, catalog };
    await RunAsOwner(SETUP);
  });

  after(async () => {
    await RunAsOwner(TEARDOWN);
  });

  describe("access", () => {
    AccessCases(() => original);
  });
  describe("refusals", () => {
    RefusalCases();
  });
  describe("closing", () => {
    ClosingCases();
  });

  it("answers from a plain Node process that cannot load any @antelopejs package", async () => {
    const built = path.join(__dirname, "..", "probe.js");
    const { stdout } = await run(process.execPath, [
      "-e",
      PLAIN_NODE_SCRIPT,
      built,
      LoginUrl(READER),
    ]);
    expect(JSON.parse(stdout)).to.include({
      outcome: "signed-in",
      user: READER,
      canRead: true,
      canWrite: false,
    });
  });
});
