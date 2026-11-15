import {
  type ChannelListener,
  subscribe,
  unsubscribe,
} from "node:diagnostics_channel";
import {
  type AddressInfo,
  Socket,
  type Server,
  connect,
  createServer,
} from "node:net";
import { z } from "zod";

/**
 * What a relay asks of each chunk of one connection, from the client or from the server: `true`
 * once the connection has gone quiet, from this chunk on.
 */
export type Stall = (chunk: Buffer, fromClient: boolean) => boolean;

/** A relay in front of a database server, and the sockets clients hold open to it. */
export interface Relay {
  port: number;
  /** The sockets still open to the relay once all have closed, or after `settleMs`. */
  openAfter: (settleMs: number) => Promise<number>;
  close: () => Promise<void>;
}

const LOOPBACK = "127.0.0.1";
const SETTLE_POLL_MS = 20;

function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function IsTcpAddress(
  address: ReturnType<Server["address"]>,
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

function PortOf(server: Server): number {
  const address = server.address();
  if (!IsTcpAddress(address)) {
    throw new Error("the relay is not listening on a TCP port");
  }
  return address.port;
}

async function Listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  return PortOf(server);
}

function Stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A local port nothing listens on. */
export async function ClosedPort(): Promise<number> {
  const server = createServer();
  const port = await Listen(server);
  await Stop(server);
  return port;
}

interface Pair {
  client: Socket;
  upstream: Socket;
  stall: Stall | undefined;
  stalled: boolean;
}

function Forward(pair: Pair, chunk: Buffer, fromClient: boolean): void {
  pair.stalled = pair.stalled || (pair.stall?.(chunk, fromClient) ?? false);
  if (!pair.stalled) {
    (fromClient ? pair.upstream : pair.client).write(chunk);
  }
}

async function StartRelay(
  targetPort: number,
  stall: Stall | undefined,
  ignoresGoodbye: boolean,
): Promise<Relay> {
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const server = createServer({ allowHalfOpen: ignoresGoodbye }, (client) => {
    const pair: Pair = {
      client,
      upstream: connect(targetPort, LOOPBACK),
      stall,
      stalled: false,
    };
    clients.add(client);
    upstreams.add(pair.upstream);
    if (ignoresGoodbye) {
      client.on("end", () => {
        pair.stalled = true;
      });
    }
    client.on("data", (chunk: Buffer) => Forward(pair, chunk, true));
    pair.upstream.on("data", (chunk: Buffer) => Forward(pair, chunk, false));
    client.on("close", () => {
      clients.delete(client);
      pair.upstream.destroy();
    });
    pair.upstream.on("close", () => {
      upstreams.delete(pair.upstream);
      if (!pair.stalled) {
        client.destroy();
      }
    });
    client.on("error", () => undefined);
    pair.upstream.on("error", () => undefined);
  });
  return {
    port: await Listen(server),
    openAfter: async (settleMs) => {
      const until = Date.now() + settleMs;
      while (clients.size > 0 && Date.now() < until) {
        await Delay(SETTLE_POLL_MS);
      }
      return clients.size;
    },
    close: async () => {
      for (const socket of [...clients, ...upstreams]) {
        socket.destroy();
      }
      await Stop(server);
    },
  };
}

/**
 * Forwards each connection to the server on `targetPort`. Once `stall` answers `true` for a
 * connection it forwards nothing more either way and closes nothing, as a server that hangs does.
 */
export function StartRelayTo(
  targetPort: number,
  stall?: Stall,
): Promise<Relay> {
  return StartRelay(targetPort, stall, false);
}

/**
 * Forwards each connection to the server on `targetPort` until the client says goodbye: a chunk
 * `goodbye` accepts, or the client ending its side. From then on it forwards and closes nothing,
 * as a server does that ignores a client leaving.
 */
export function StartRelayIgnoringGoodbye(
  targetPort: number,
  goodbye: Stall,
): Promise<Relay> {
  return StartRelay(targetPort, goodbye, true);
}

const CLIENT_SOCKET_CHANNEL = "net.client.socket";

/** The client sockets this process opens to one port, whichever library opens them. */
export interface ClientSockets {
  /** How many were opened, and how many of them are not destroyed once all are, or after `settleMs`. */
  settle: (settleMs: number) => Promise<{ opened: number; open: number }>;
  stop: () => void;
}

/** What the channel publishes for each client socket. */
const ClientSocketMessage = z.object({ socket: z.instanceof(Socket) });

/** Watches the client sockets this process opens to `port` from now on. */
export function WatchClientSockets(port: number): ClientSockets {
  const sockets = new Set<Socket>();
  const track: ChannelListener = (message) => {
    const { socket } = ClientSocketMessage.parse(message);
    socket.once("connect", () => {
      if (socket.remotePort === port) {
        sockets.add(socket);
      }
    });
  };
  const open = () => [...sockets].filter((socket) => !socket.destroyed).length;
  subscribe(CLIENT_SOCKET_CHANNEL, track);
  return {
    settle: async (settleMs) => {
      const until = Date.now() + settleMs;
      while (open() > 0 && Date.now() < until) {
        await Delay(SETTLE_POLL_MS);
      }
      return { opened: sockets.size, open: open() };
    },
    stop: () => {
      unsubscribe(CLIENT_SOCKET_CHANNEL, track);
    },
  };
}

/** PostgreSQL's AuthenticationCleartextPassword: an `R` message of length 8 asking for method 3. */
export const CLEARTEXT_PASSWORD_REQUEST = Buffer.from([
  0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x03,
]);

/** PostgreSQL's AuthenticationOk then ReadyForQuery: signed in, and idle. */
export const SIGNED_IN = Buffer.from([
  0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x5a, 0x00, 0x00, 0x00,
  0x05, 0x49,
]);

/** A server that answers each client's first packet the same way, and what clients sent it. */
export interface RecordingServer {
  port: number;
  /** How many clients connected. */
  connections: () => number;
  /** The first packet a client sent, before the server said anything. */
  first: () => Buffer | undefined;
  /** The bytes clients sent after the server answered their first packet. */
  received: () => number;
  close: () => Promise<void>;
}

/**
 * Starts a server that answers every client's first packet with `reply`, then never answers
 * again; with no `reply` it hangs up after the first packet.
 */
export async function StartRecordingServer(
  reply?: Buffer,
): Promise<RecordingServer> {
  const sockets = new Set<Socket>();
  let received = 0;
  let first: Buffer | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (answered) {
        received += chunk.length;
        return;
      }
      answered = true;
      first ??= chunk;
      if (reply) {
        socket.write(reply);
      } else {
        socket.destroy();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  return {
    port: await Listen(server),
    connections: () => connections,
    first: () => first,
    received: () => received,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Stop(server);
    },
  };
}
