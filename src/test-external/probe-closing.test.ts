import { expect } from "chai";

import {
  ABORTED_ANSWER,
  LOGIN,
  LoginUrl,
  OnPort,
  Probe,
  ServerPort,
  SignedIn,
  WithProbeLogins,
} from "./probe-fixture";
import {
  type ClientSockets,
  type Relay,
  StartRelayIgnoringGoodbye,
  StartRelayTo,
  WatchClientSockets,
} from "./relays";

const CLOSE_SETTLE_MS = 1000;
/** Shorter than the 250 ms grace, so only an abort that shuts at once passes. */
const ABORT_SETTLE_MS = 100;

/** The first byte of a simple query message, PostgreSQL's Query. */
const QUERY_MESSAGE = 0x51;
/** The first byte of the message a client sends before it closes, PostgreSQL's Terminate. */
const TERMINATE_MESSAGE = 0x58;

function SaysGoodbye(chunk: Buffer, fromClient: boolean): boolean {
  return fromClient && chunk[0] === TERMINATE_MESSAGE;
}

/** Runs `check` against a relay and the client sockets opened to it, then closes both. */
async function WithRelay(
  relay: Relay,
  check: (relay: Relay, sockets: ClientSockets) => Promise<void>,
): Promise<void> {
  const sockets = WatchClientSockets(relay.port);
  try {
    await check(relay, sockets);
  } finally {
    sockets.stop();
    await relay.close();
  }
}

function ReaderOn(relay: Relay): string {
  return OnPort(LoginUrl(LOGIN.reader), relay.port);
}

describe("the connection probe's closing", function () {
  this.timeout(60_000);
  WithProbeLogins();

  it("closes its connection once it has answered", async () => {
    await WithRelay(await StartRelayTo(ServerPort()), async (relay) => {
      SignedIn(await Probe(ReaderOn(relay)));
      expect(await relay.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    });
  });

  it("shuts its socket when the server ignores the goodbye", async () => {
    const relay = await StartRelayIgnoringGoodbye(ServerPort(), SaysGoodbye);
    await WithRelay(relay, async (_, sockets) => {
      const answer = SignedIn(await Probe(ReaderOn(relay)));
      expect(answer).to.include({ user: LOGIN.reader, canRead: true });
      expect(await sockets.settle(CLOSE_SETTLE_MS)).to.deep.equal({
        opened: 1,
        open: 0,
      });
    });
  });

  it("shuts its socket at once when the signal aborts while it closes", async () => {
    const relay = await StartRelayIgnoringGoodbye(ServerPort(), SaysGoodbye);
    await WithRelay(relay, async (_, sockets) => {
      const controller = new AbortController();
      SignedIn(await Probe(ReaderOn(relay), controller.signal));
      controller.abort();
      expect(await sockets.settle(ABORT_SETTLE_MS)).to.deep.equal({
        opened: 1,
        open: 0,
      });
    });
  });

  it("answers unreachable and closes when the server stops answering after the sign-in", async () => {
    const stall = (chunk: Buffer, fromClient: boolean) =>
      fromClient && chunk[0] === QUERY_MESSAGE;
    await WithRelay(await StartRelayTo(ServerPort(), stall), async (relay) => {
      const answer = await Probe(ReaderOn(relay));
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
    const relay = await StartRelayTo(ServerPort(), stall);
    await WithRelay(relay, async (_, sockets) => {
      const answer = await Probe(ReaderOn(relay), controller.signal);
      expect(performance.now() - abortedAt).to.be.lessThan(ABORT_SETTLE_MS);
      expect(answer).to.deep.equal(ABORTED_ANSWER);
      expect(await sockets.settle(ABORT_SETTLE_MS)).to.deep.equal({
        opened: 1,
        open: 0,
      });
    });
  });

  it("answers aborted and opens nothing when the signal has already aborted", async () => {
    const relay = await StartRelayTo(ServerPort());
    await WithRelay(relay, async (_, sockets) => {
      const answer = await Probe(ReaderOn(relay), AbortSignal.abort());
      expect(answer).to.deep.equal(ABORTED_ANSWER);
      expect(await sockets.settle(ABORT_SETTLE_MS)).to.deep.equal({
        opened: 0,
        open: 0,
      });
    });
  });
});
