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
import { ClosedPort } from "./relays";

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
    const url = Altered(LoginUrl(LOGIN.reader), (target) => {
      target.password = "";
    });
    expect(await Probe(url)).to.include({
      outcome: "refused",
      refusal: "sign-in-required",
    });
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
