import { expect } from "chai";

import { probe } from "../probe";
import {
  Altered,
  CountAsOwner,
  LOGIN,
  LoginUrl,
  OnPort,
  Probe,
  SCRIBBLE_SCHEMA,
  SignedIn,
  WithEnvironment,
  WithProbeLogins,
} from "./probe-fixture";
import {
  ClosedPort,
  type RecordingServer,
  SIGNED_IN,
  StartRecordingServer,
} from "./relays";

/** Short, so a URL parameter that lifts a bound shows as an answer far past it. */
const BOUND_MS = 300;

/** Where a URL that lifts the bound would still be waiting. */
const LIFTED_MS = 60_000;

const NO_CONNECTION = { connections: 0, received: 0 };

function WithParameter(url: string, name: string, value: string): string {
  return Altered(url, (target) => {
    target.searchParams.set(name, value);
  });
}

function Bounded(url: string) {
  return probe({
    url,
    timeoutMs: BOUND_MS,
    signal: new AbortController().signal,
  });
}

/** The parameters of a PostgreSQL StartupMessage: length, protocol, then `name\0value\0` pairs. */
function StartupParameters(packet: Buffer | undefined): Map<string, string> {
  const fields = (packet ?? Buffer.alloc(0))
    .subarray(8, -1)
    .toString("utf8")
    .split("\0")
    .slice(0, -1);
  const parameters = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    parameters.set(fields[index], fields[index + 1]);
  }
  return parameters;
}

async function WithServer(
  server: RecordingServer,
  check: (server: RecordingServer) => Promise<void>,
): Promise<void> {
  try {
    await check(server);
  } finally {
    await server.close();
  }
}

function Seen(server: RecordingServer) {
  return { connections: server.connections(), received: server.received() };
}

/**
 * What a URL parameter must leave in the StartupMessage: the URL's value where the URL decides,
 * the probe's where the probe decides, or nothing.
 */
const STARTUP_ROWS = [
  { name: "statement_timeout", value: "0", sent: String(BOUND_MS) },
  { name: "lock_timeout", value: "0", sent: String(BOUND_MS) },
  {
    name: "idle_in_transaction_session_timeout",
    value: "0",
    sent: String(BOUND_MS),
  },
  { name: "replication", value: "database", sent: undefined },
  { name: "application_name", value: "probe-app", sent: "probe-app" },
  { name: "options", value: "-c search_path=x", sent: "-c search_path=x" },
];

/** A server's yes to an SSLRequest. */
const TLS_ACCEPTED = Buffer.from("S");

/** Long enough that work worse than linear in it would take seconds. */
const HOSTILE_LENGTH = 1_000_000;

/** URLs whose every value is long and awkward for a parser, on a port nothing listens on. */
function HostileUrls(port: number): Map<string, string> {
  const base = `postgres://${LOGIN.reader}:secret@127.0.0.1:${port}/shop`;
  const repeat = (text: string) =>
    text.repeat(Math.ceil(HOSTILE_LENGTH / text.length));
  return new Map([
    ["host", `postgres://${LOGIN.reader}:secret@${repeat("a")}:${port}/shop`],
    ["user", `postgres://${repeat("%2")}:secret@127.0.0.1:${port}/shop`],
    [
      "database",
      `postgres://${LOGIN.reader}:secret@127.0.0.1:${port}/${repeat("%41")}`,
    ],
    ["options", `${base}?options=${repeat("-c%20a%3Db%20")}`],
    ["application_name", `${base}?application_name=${repeat("a")}`],
    ["bad escapes", `${base}?x=${repeat("%zz %")}`],
    ["parameter count", `${base}?${repeat("k=v&")}`],
    ["sslmode", `${base}?sslmode=${repeat("verify-")}`],
  ]);
}

function CredentialCases() {
  it("refuses a URL with no user before connecting, whatever PGUSER says", async () => {
    await WithServer(await StartRecordingServer(), async (server) => {
      const url = Altered(
        OnPort(LoginUrl(LOGIN.reader), server.port),
        (target) => {
          target.username = "";
        },
      );
      await WithEnvironment({ PGUSER: LOGIN.reader }, async () => {
        expect(await Probe(url)).to.include({
          outcome: "refused",
          refusal: "other",
        });
      });
      expect(Seen(server)).to.deep.equal(NO_CONNECTION);
    });
  });

  it("refuses a URL with no host before connecting, whatever PGHOST says", async () => {
    await WithEnvironment({ PGHOST: "127.0.0.1" }, async () => {
      const answer = await Probe(`postgres://${LOGIN.reader}:secret@/shop`);
      expect(answer).to.include({ outcome: "refused", refusal: "other" });
      expect(answer).to.have.property("message").that.contains("no host");
    });
  });

  it("refuses a client certificate of the probing host before connecting", async () => {
    await WithServer(await StartRecordingServer(), async (server) => {
      for (const name of ["sslcert", "sslkey"]) {
        const url = WithParameter(
          OnPort(LoginUrl(LOGIN.reader), server.port),
          name,
          __filename,
        );
        expect(await Probe(url), name).to.include({
          outcome: "refused",
          refusal: "other",
        });
      }
      expect(Seen(server)).to.deep.equal(NO_CONNECTION);
    });
  });
}

function WorkCases() {
  const ROOT_CERTIFICATES = [
    "/dev/zero",
    __dirname,
    "/proc/self/pagemap",
    __filename,
  ];
  for (const path of ROOT_CERTIFICATES) {
    it(`refuses sslrootcert=${path} without reading it`, async () => {
      await WithServer(await StartRecordingServer(), async (server) => {
        const url = WithParameter(
          OnPort(LoginUrl(LOGIN.reader), server.port),
          "sslrootcert",
          path,
        );
        const started = performance.now();
        expect(await Bounded(url)).to.include({
          outcome: "refused",
          refusal: "other",
        });
        expect(performance.now() - started).to.be.lessThan(BOUND_MS);
        expect(Seen(server)).to.deep.equal(NO_CONNECTION);
      });
    });
  }

  for (const query of [
    "ssl=false",
    "ssl=require",
    "ssl=abc",
    "ssl=false&sslmode=",
  ]) {
    it(`refuses ${query}, which pg fails on once TLS starts, before connecting`, async () => {
      await WithServer(
        await StartRecordingServer(TLS_ACCEPTED),
        async (server) => {
          const url = `${OnPort(LoginUrl(LOGIN.reader), server.port)}?${query}`;
          expect(await Bounded(url)).to.include({
            outcome: "refused",
            refusal: "other",
          });
          expect(Seen(server)).to.deep.equal(NO_CONNECTION);
        },
      );
    });
  }

  for (const query of ["ssl=", "ssl=0"]) {
    it(`keeps ${query}, which pg reads as no TLS`, async () => {
      await WithServer(await StartRecordingServer(), async (server) => {
        await Bounded(
          `${OnPort(LoginUrl(LOGIN.reader), server.port)}?${query}`,
        );
        expect(StartupParameters(server.first()).get("user")).to.equal(
          LOGIN.reader,
        );
      });
    });
  }

  it("keeps ssl=no-verify and asks for TLS", async () => {
    await WithServer(await StartRecordingServer(), async (server) => {
      await Bounded(
        WithParameter(
          OnPort(LoginUrl(LOGIN.reader), server.port),
          "ssl",
          "no-verify",
        ),
      );
      expect(server.connections()).to.equal(1);
    });
  });

  it("refuses many sslrootcert keys within its bound", async () => {
    const url = `${OnPort(LoginUrl(LOGIN.reader), await ClosedPort())}?${`sslrootcert=${__filename}&`.repeat(10_000)}`;
    const started = performance.now();
    expect(await Bounded(url)).to.include({
      outcome: "refused",
      refusal: "other",
    });
    expect(performance.now() - started).to.be.lessThan(BOUND_MS);
  });

  for (const [key, character] of [
    ["sslkey", "\t"],
    ["sslcert", "\n"],
    ["sslrootcert", "\r"],
  ]) {
    it(`refuses ${key} with ${JSON.stringify(character)} inside its name before reading it`, async () => {
      await WithServer(await StartRecordingServer(), async (server) => {
        const name = `${key.slice(0, 3)}${character}${key.slice(3)}`;
        const path = key === "sslrootcert" ? "/dev/zero" : __filename;
        const url = `${OnPort(LoginUrl(LOGIN.reader), server.port)}?${name}=${path}`;
        const started = performance.now();
        expect(await Bounded(url)).to.include({
          outcome: "refused",
          refusal: "other",
        });
        expect(performance.now() - started).to.be.lessThan(BOUND_MS);
        expect(Seen(server)).to.deep.equal(NO_CONNECTION);
      });
    });
  }

  it("answers within its bound however long and awkward each URL value is", async () => {
    for (const [name, url] of HostileUrls(await ClosedPort())) {
      const started = performance.now();
      const answer = await Bounded(url);
      expect(performance.now() - started, name).to.be.lessThan(BOUND_MS * 4);
      expect(answer.outcome, name).to.not.equal("signed-in");
    }
  });
}

function ParameterCases() {
  for (const { name, value, sent } of STARTUP_ROWS) {
    it(`sends ${name} as ${sent ?? "nothing"} when the URL says ${value}`, async () => {
      await WithServer(await StartRecordingServer(), async (server) => {
        const url = WithParameter(
          OnPort(LoginUrl(LOGIN.reader), server.port),
          name,
          value,
        );
        await Bounded(url);
        const parameters = StartupParameters(server.first());
        expect(parameters.get("user")).to.equal(LOGIN.reader);
        expect(parameters.get(name)).to.equal(sent);
      });
    });
  }

  it("answers within its bound when the URL lifts query_timeout", async () => {
    await WithServer(await StartRecordingServer(SIGNED_IN), async (server) => {
      const url = WithParameter(
        OnPort(LoginUrl(LOGIN.reader), server.port),
        "query_timeout",
        String(LIFTED_MS),
      );
      const started = performance.now();
      const answer = await Bounded(url);
      expect(performance.now() - started).to.be.lessThan(BOUND_MS * 4);
      expect(answer.outcome).to.equal("unreachable");
    });
  });

  it("changes no row when the URL's options put a writing function on the path", async () => {
    const url = WithParameter(
      LoginUrl(LOGIN.writer),
      "options",
      `-c search_path=${SCRIBBLE_SCHEMA},pg_catalog`,
    );
    const answer = SignedIn(await Probe(url));
    expect(answer).to.include({ unreadable: "cannot-list" });
    expect(await CountAsOwner(`${SCRIBBLE_SCHEMA}.marks`)).to.equal(0);
  });
}

describe("the connection probe's URL", function () {
  this.timeout(60_000);
  WithProbeLogins();

  describe("credentials", () => {
    CredentialCases();
  });

  describe("work before the probe can refuse", () => {
    WorkCases();
  });

  describe("parameters", () => {
    ParameterCases();
  });
});
