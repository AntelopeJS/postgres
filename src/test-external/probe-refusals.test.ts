import { expect } from "chai";

import {
  Altered,
  LOCKED_DATABASE,
  LOGIN,
  LoginUrl,
  NO_LOGIN,
  OnPort,
  Probe,
  TIMEOUT_MS,
  WithProbeLogins,
} from "./probe-fixture";
import { ClosedPort, StartPasswordServer } from "./relays";

function WithoutPassword(url: string): string {
  return Altered(url, (target) => {
    target.password = "";
  });
}

/** Runs `check` with `PGPASSWORD` set to `password`, then puts the environment back. */
async function WithPgPassword(
  password: string,
  check: () => Promise<void>,
): Promise<void> {
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = password;
  try {
    await check();
  } finally {
    if (previous === undefined) {
      delete process.env.PGPASSWORD;
    } else {
      process.env.PGPASSWORD = previous;
    }
  }
}

/** PostgreSQL's SSLRequest: length 8, then the request code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

function OnDatabase(url: string, database: string): string {
  return Altered(url, (target) => {
    target.pathname = `/${database}`;
  });
}

describe("the connection probe's refusals", function () {
  this.timeout(60_000);
  WithProbeLogins();

  it("refuses a wrong password as credentials", async () => {
    const answer = await Probe(LoginUrl(LOGIN.reader, "not-the-password"));
    expect(answer).to.include({ outcome: "refused", refusal: "credentials" });
  });

  it("refuses a login the server does not let in as host", async () => {
    expect(await Probe(LoginUrl(NO_LOGIN))).to.include({
      outcome: "refused",
      refusal: "host",
    });
  });

  it("refuses a database the server does not have as database", async () => {
    const url = OnDatabase(LoginUrl(LOGIN.reader), "antelopejs_missing");
    expect(await Probe(url)).to.include({
      outcome: "refused",
      refusal: "database",
    });
  });

  it("refuses a database the login may not connect to as database-denied", async () => {
    const url = OnDatabase(LoginUrl(LOGIN.reader), LOCKED_DATABASE);
    expect(await Probe(url)).to.include({
      outcome: "refused",
      refusal: "database-denied",
    });
  });

  it("refuses a URL without the password the server asks for as sign-in-required", async () => {
    expect(await Probe(WithoutPassword(LoginUrl(LOGIN.reader)))).to.include({
      outcome: "refused",
      refusal: "sign-in-required",
    });
  });

  it("never fills a password the URL lacks from PGPASSWORD", async () => {
    const reader = LoginUrl(LOGIN.reader);
    await WithPgPassword(new URL(reader).password, async () => {
      expect(await Probe(WithoutPassword(reader))).to.include({
        outcome: "refused",
        refusal: "sign-in-required",
      });
    });
  });

  it("sends nothing to a server asking for a cleartext password the URL lacks", async () => {
    const server = await StartPasswordServer();
    try {
      await WithPgPassword("the probing process's own secret", async () => {
        const url = WithoutPassword(
          OnPort(LoginUrl(LOGIN.reader), server.port),
        );
        expect(await Probe(url)).to.include({
          outcome: "refused",
          refusal: "sign-in-required",
        });
      });
      expect(server.received()).to.equal(0);
    } finally {
      await server.close();
    }
  });

  it("asks for TLS before anything else when the URL says ssl=no-verify", async () => {
    const server = await StartPasswordServer();
    try {
      const url = Altered(
        OnPort(LoginUrl(LOGIN.reader), server.port),
        (target) => {
          target.searchParams.set("ssl", "no-verify");
        },
      );
      await Probe(url);
      expect(server.first()).to.deep.equal(SSL_REQUEST);
      expect(server.received()).to.equal(0);
    } finally {
      await server.close();
    }
  });

  it("refuses any other server error during the sign-in as other, with its message", async () => {
    const url = Altered(LoginUrl(LOGIN.reader), (target) => {
      target.searchParams.set("options", "-c probe_bogus=1");
    });
    const answer = await Probe(url);
    expect(answer).to.include({ outcome: "refused", refusal: "other" });
    expect(answer).to.have.property("message").that.contains("probe_bogus");
  });

  it("answers a port nothing listens on as unreachable, within the timeout", async () => {
    const started = performance.now();
    const answer = await Probe(
      OnPort(LoginUrl(LOGIN.reader), await ClosedPort()),
    );
    expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS);
    expect(answer.outcome).to.equal("unreachable");
  });

  it("says why when every address of a host name refuses", async () => {
    const port = await ClosedPort();
    const answer = await Probe(
      OnPort(LoginUrl(LOGIN.reader), port, "localhost"),
    );
    expect(answer.outcome).to.equal("unreachable");
    expect(answer).to.have.property("message").that.contains("ECONNREFUSED");
  });
});
