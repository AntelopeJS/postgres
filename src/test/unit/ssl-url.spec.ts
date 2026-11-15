import { execFile } from "node:child_process";
import {
  type AddressInfo,
  type Server,
  type Socket,
  createServer,
} from "node:net";
import path from "node:path";

import { expect } from "chai";

import { GetOptions, type Options } from "../../config";
import { WithOptions } from "./spec-fixture";

const BASE = "postgres://reader:secret@client-db/erp";

/** Values `pg` keeps as text and then fails on, outside any promise, once TLS starts. */
const UNUSABLE = ["false", "require", "abc", "FALSE"];

/** Values `pg` turns into a TLS setting or skips, and a text `sslmode` replaces before `pg` reads it. */
const USABLE = [
  "ssl=true",
  "ssl=1",
  "ssl=0",
  "ssl=",
  "ssl=no-verify",
  "sslmode=require&ssl=false",
];

/**
 * Connects in a process of its own, with the options it is given as JSON, and prints how it ended.
 * The process this spec runs in hosts a live, constructed adapter that `Connect` would disconnect.
 */
const CONNECT_SCRIPT = `
const { Connect, Disconnect } = require(process.argv[1]);
Connect(JSON.parse(process.argv[2])).then(
  () => Disconnect().then(() => console.log("connected")),
  (err) => console.log("refused: " + err.message),
);
`;

const CONNECTION_MODULE = path.join(__dirname, "..", "..", "connection.js");

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
  const server = createServer((socket) => {
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

interface Ending {
  exited: boolean;
  output: string;
}

function ConnectElsewhere(optionsJson: string): Promise<Ending> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["-e", CONNECT_SCRIPT, CONNECTION_MODULE, optionsJson],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        resolve({ exited: error !== null, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** Where an unusable `ssl` can come from, each against a server that accepts TLS. */
function UnusableConfigs(port: number): [string, string][] {
  const url = `postgres://reader:secret@127.0.0.1:${port}/erp`;
  return [
    ["config.url", JSON.stringify({ url: `${url}?ssl=false` })],
    [
      "config.pool",
      JSON.stringify({ url, pool: { connectionString: `${url}?ssl=false` } }),
    ],
    ["config.pool", JSON.stringify({ url, pool: { ssl: "false" } })],
  ];
}

function Configured(options: Options): string {
  return WithOptions(options, () => GetOptions().url);
}

describe("a config.url with an ssl value pg cannot use", function () {
  this.timeout(30_000);

  it("fails at start against a server that accepts TLS, naming the value, and the process lives", async () => {
    const server = await StartTlsServer();
    try {
      for (const [source, optionsJson] of UnusableConfigs(server.port)) {
        const ending = await ConnectElsewhere(optionsJson);
        expect(ending.exited, ending.output).to.equal(false);
        expect(ending.output).to.contain("refused: ").and.contain(source);
      }
      expect(server.connections()).to.equal(0);
    } finally {
      await server.close();
    }
  });

  for (const value of UNUSABLE) {
    it(`is refused for ssl=${value}, naming it`, () => {
      expect(() => Configured({ url: `${BASE}?ssl=${value}` })).to.throw(
        `ssl=${value}`,
      );
    });
  }

  it("is accepted for a socket URL with ssl=true, which pg converts", () => {
    const url = "socket:///var/run/postgresql?db=erp&ssl=true";
    expect(Configured({ url })).to.equal(url);
  });

  it("is accepted for pool.ssl set to true or false", () => {
    for (const ssl of [true, false]) {
      expect(Configured({ url: BASE, pool: { ssl } })).to.equal(BASE);
    }
  });

  for (const query of USABLE) {
    it(`is accepted for ${query}`, () => {
      expect(Configured({ url: `${BASE}?${query}` })).to.contain(query);
    });
  }
});
