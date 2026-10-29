import { expect } from "chai";

import { type CatalogOptions, GetOptions } from "../config";
import { Connect, Query } from "../connection";
import { Info } from "../implementations/catalog";

const EXTERNAL = "external";
const WRONG_PASSWORD = "not-the-password";
const CLOSED_PORT = "1";
const NO_DATABASE = "antelopejs_missing";

interface Restorable {
  url: string;
  catalog: CatalogOptions;
}

async function Refusal<T>(work: () => PromiseLike<T>): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("the call was expected to be refused");
}

function Altered(url: string, change: (target: URL) => void): string {
  const target = new URL(url);
  change(target);
  return target.toString();
}

describe("an external instance whose first connection fails", () => {
  let original: Restorable;

  before(() => {
    const { url, catalog } = GetOptions();
    original = { url, catalog };
  });

  after(async () => {
    await Connect({ mode: EXTERNAL, ...original });
  });

  function ConnectTo(url: string, catalog: CatalogOptions) {
    return Connect({ mode: EXTERNAL, url, catalog });
  }

  function WithWrongPassword() {
    return Altered(original.url, (target) => {
      target.password = WRONG_PASSWORD;
    });
  }

  describe("with the catalog enabled", () => {
    const ENABLED = { enabled: true };

    it("starts with a wrong password, and Info() and a query refuse with the reason", async () => {
      await ConnectTo(WithWrongPassword(), ENABLED);
      const expected = "not connected: wrong user or password (28P01)";
      expect(await Refusal(() => Info())).to.contain(expected);
      expect(await Refusal(() => Query("SELECT 1"))).to.contain(expected);
    });

    it("starts with a port nobody answers on, naming the host and port", async () => {
      const url = Altered(original.url, (target) => {
        target.port = CLOSED_PORT;
      });
      await ConnectTo(url, ENABLED);
      const { hostname } = new URL(url);
      expect(await Refusal(() => Info())).to.contain(
        `not connected: the server is not answering at ${hostname}:${CLOSED_PORT} (ECONNREFUSED)`,
      );
    });

    it("starts with a database that does not exist", async () => {
      const url = Altered(original.url, (target) => {
        target.pathname = `/${NO_DATABASE}`;
      });
      await ConnectTo(url, ENABLED);
      expect(await Refusal(() => Info())).to.contain(
        "not connected: the database does not exist (3D000)",
      );
    });

    it("connects again on the next construct once the URL is right", async () => {
      await ConnectTo(WithWrongPassword(), ENABLED);
      await ConnectTo(original.url, ENABLED);
      const result = await Query<{ one: number }>("SELECT 1 AS one");
      expect(result.rows[0].one).to.equal(1);
    });
  });

  it("refuses to start with the catalog disabled", async () => {
    const message = await Refusal(() =>
      ConnectTo(WithWrongPassword(), { enabled: false }),
    );
    expect(message).to.contain("password authentication failed");
  });

  it("refuses to start outside development when the catalog is left to follow it", async () => {
    const message = await Refusal(() => ConnectTo(WithWrongPassword(), {}));
    expect(message).to.contain("password authentication failed");
  });
});
