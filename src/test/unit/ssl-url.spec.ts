import {
  type AddressInfo,
  type Server,
  type Socket,
  createServer,
} from "node:net";

import { expect } from "chai";

import { type Options, SetOptions } from "../../config";
import { Connect } from "../../connection";

/** Values `pg` keeps as a string and then fails on, outside any promise, once TLS starts. */
const UNUSABLE = ["false", "require", "abc", "FALSE"];

/** Values `pg` turns into a TLS setting or skips, and a string `sslmode` replaces before `pg` reads it. */
const USABLE = [
  "ssl=true",
  "ssl=1",
  "ssl=0",
  "ssl=",
  "ssl=no-verify",
  "sslmode=require&ssl=false",
];

/** Where an unusable `ssl` can come from, each against a server that accepts TLS. */
function UnusableConfigs(port: number): Map<string, Options> {
  const url = `postgres://reader:secret@127.0.0.1:${port}/erp`;
  return new Map<string, Options>([
    ["config.url", { url: `${url}?ssl=false` }],
    [
      "pool.connectionString",
      { url, pool: { connectionString: `${url}?ssl=false` } },
    ],
    ["pool.ssl", { url, pool: Object.fromEntries([["ssl", "false"]]) }],
  ]);
}

/** A server that says yes to every SSLRequest, and counts who connected. */
interface TlsServer {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

function IsTcpAddress(
  address: ReturnType<Server["address"]>,
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

async function StartTlsServer(): Promise<TlsServer> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("data", () => socket.write("S"));
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!IsTcpAddress(address)) {
    throw new Error("the server is not listening on a TCP port");
  }
  return {
    port: address.port,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function Refusal(work: () => PromiseLike<void>): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("the call was expected to be refused");
}

describe("a config.url with an ssl value pg cannot use", () => {
  it("fails at start against a server that accepts TLS, naming the value, and never connects", async () => {
    const server = await StartTlsServer();
    try {
      for (const [source, options] of UnusableConfigs(server.port)) {
        const message = await Refusal(() => Connect(options));
        expect(message, source).to.contain("false");
        expect(message, source).to.contain(source.split(".")[0]);
      }
      expect(server.connections()).to.equal(0);
    } finally {
      await server.close();
    }
  });

  for (const value of UNUSABLE) {
    it(`is refused for ssl=${value}, naming it`, () => {
      expect(() =>
        SetOptions({
          url: `postgres://reader:secret@client-db/erp?ssl=${value}`,
        }),
      ).to.throw(`ssl=${value}`);
    });
  }

  it("is accepted for a socket URL with ssl=true, which pg converts", () => {
    const url = "socket:///var/run/postgresql?db=erp&ssl=true";
    expect(SetOptions({ url }).url).to.equal(url);
  });

  it("is accepted for pool.ssl set to true or false", () => {
    for (const ssl of [true, false]) {
      expect(SetOptions({ pool: { ssl } }).pool.ssl).to.equal(ssl);
    }
  });

  for (const query of USABLE) {
    it(`is accepted for ${query}`, () => {
      expect(
        SetOptions({ url: `postgres://reader:secret@client-db/erp?${query}` })
          .url,
      ).to.contain(query);
    });
  }
});
