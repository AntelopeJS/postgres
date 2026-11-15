import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { RelationSummary } from "@antelopejs/interface-database-catalog";
import { expect } from "chai";

import { GetOptions } from "../config";
import { Connect } from "../connection";
import { ListRelations } from "../implementations/catalog";
import {
  LOGIN,
  LoginUrl,
  Probe,
  SignedIn,
  WithProbeLogins,
} from "./probe-fixture";

const run = promisify(execFile);

const EXTERNAL = "external";

const CASES = [
  { role: LOGIN.reader, canRead: true, canWrite: false },
  { role: LOGIN.writer, canRead: true, canWrite: true },
  { role: LOGIN.updater, canRead: false, canWrite: true },
  { role: LOGIN.deleter, canRead: false, canWrite: true },
  { role: LOGIN.columns, canRead: false, canWrite: false },
  { role: LOGIN.blind, canRead: false, canWrite: false },
  { role: LOGIN.unseen, canRead: true, canWrite: false },
  { role: LOGIN.grantee, canRead: true, canWrite: false },
];

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

describe("the connection probe's access", function () {
  this.timeout(60_000);
  WithProbeLogins();

  describe("compared with the catalog", () => {
    const { url, catalog } = GetOptions();

    after(async () => {
      await Connect({ mode: EXTERNAL, url, catalog });
    });

    for (const { role, canRead, canWrite } of CASES) {
      it(`answers ${role} with the access the catalog gives it`, async () => {
        const login = LoginUrl(role);
        const answer = SignedIn(await Probe(login));
        expect(answer).to.include({ user: role, canRead, canWrite });
        expect(answer).to.not.have.property("unreadable");
        expect(answer.latencyMs).to.be.at.least(1);
        expect({ canRead, canWrite }).to.deep.equal(await CatalogAccess(login));
      });
    }
  });

  it("answers signed-in and cannot-list when the relation listing fails after the sign-in", async () => {
    const answer = SignedIn(await Probe(LoginUrl(LOGIN.trapped)));
    expect(answer).to.include({
      user: LOGIN.trapped,
      canRead: false,
      canWrite: false,
      unreadable: "cannot-list",
    });
  });

  it("answers from a plain Node process that cannot load any @antelopejs package", async () => {
    const built = path.join(__dirname, "..", "probe.js");
    const { stdout } = await run(process.execPath, [
      "-e",
      PLAIN_NODE_SCRIPT,
      built,
      LoginUrl(LOGIN.reader),
    ]);
    expect(JSON.parse(stdout)).to.include({
      outcome: "signed-in",
      user: LOGIN.reader,
      canRead: true,
      canWrite: false,
    });
  });
});
