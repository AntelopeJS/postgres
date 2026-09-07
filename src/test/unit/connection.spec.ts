import { expect } from "chai";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";

import {
  type BeforeDisconnect,
  GuardHeldClient,
  GuardPool,
  type PoolTeardown,
  RegisterBeforeDisconnect,
  SettleBeforeDisconnect,
} from "../../connection";

const POOL_END = "pool.end";

const CLIENT_ERROR = "error";
const DROPPED = "Connection terminated unexpectedly";
const CHECKOUTS = 2;
const NO_ARGUMENTS: unknown[] = [];

function Recording(log: string[], name: string): BeforeDisconnect {
  return () => {
    log.push(name);
  };
}

function RecordingAfterSuspension(
  log: string[],
  name: string,
): BeforeDisconnect {
  return async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    log.push(name);
  };
}

function Throwing(log: string[], name: string): BeforeDisconnect {
  return () => {
    log.push(name);
    throw new Error(name);
  };
}

function Rejecting(log: string[], name: string): BeforeDisconnect {
  return async () => {
    log.push(name);
    throw new Error(name);
  };
}

function EndingInto(log: string[]): PoolTeardown {
  return async () => {
    log.push(POOL_END);
  };
}

async function Sweep(log: string[], callbacks: BeforeDisconnect[]) {
  const withdrawals = callbacks.map((callback) =>
    RegisterBeforeDisconnect(callback),
  );
  try {
    await SettleBeforeDisconnect(EndingInto(log));
  } finally {
    for (const withdraw of withdrawals) {
      withdraw();
    }
  }
}

describe("the before-disconnect registry", () => {
  it("runs a registered callback before the pool is ended", async () => {
    const log: string[] = [];
    await Sweep(log, [Recording(log, "cursors")]);
    expect(log).to.deep.equal(["cursors", POOL_END]);
  });

  it("waits for a callback that only finishes after a suspension point", async () => {
    const log: string[] = [];
    await Sweep(log, [RecordingAfterSuspension(log, "cursors")]);
    expect(log).to.deep.equal(["cursors", POOL_END]);
  });

  it("runs every registered callback, in registration order", async () => {
    const log: string[] = [];
    await Sweep(log, [
      Recording(log, "first"),
      Recording(log, "second"),
      Recording(log, "third"),
    ]);
    expect(log).to.deep.equal(["first", "second", "third", POOL_END]);
  });

  it("ends the pool anyway when a callback throws synchronously", async () => {
    const log: string[] = [];
    await Sweep(log, [Throwing(log, "broken"), Recording(log, "healthy")]);
    expect(log).to.deep.equal(["broken", "healthy", POOL_END]);
  });

  it("ends the pool anyway when a callback rejects", async () => {
    const log: string[] = [];
    await Sweep(log, [Rejecting(log, "broken"), Recording(log, "healthy")]);
    expect(log).to.deep.equal(["broken", "healthy", POOL_END]);
  });

  it("keeps registrations across a disconnect, so the next one sweeps again", async () => {
    const log: string[] = [];
    const withdraw = RegisterBeforeDisconnect(Recording(log, "cursors"));
    try {
      await SettleBeforeDisconnect(EndingInto(log));
      await SettleBeforeDisconnect(EndingInto(log));
    } finally {
      withdraw();
    }
    expect(log).to.deep.equal(["cursors", POOL_END, "cursors", POOL_END]);
  });

  it("stops running a callback whose registration was withdrawn", async () => {
    const log: string[] = [];
    RegisterBeforeDisconnect(Recording(log, "cursors"))();
    await SettleBeforeDisconnect(EndingInto(log));
    expect(log).to.deep.equal([POOL_END]);
  });

  it("ends the pool when nothing is registered", async () => {
    const log: string[] = [];
    await Sweep(log, []);
    expect(log).to.deep.equal([POOL_END]);
  });
});

interface Checkout {
  releases: number;
  arguments: unknown[][];
}

function Checkouts(): Checkout {
  return { releases: 0, arguments: [] };
}

/**
 * Hands a client out the way `pg-pool` does, and guards it the way `AcquireClient` does.
 *
 * The reassignment is the point rather than stub convenience: the pool installs a **fresh**
 * `release` on every checkout, so a guard applied once per client would be discarded by the next
 * one and the listener it attached would never come off. Driving the guard through this is what
 * makes the accumulation spec below able to fail.
 */
function CheckOut(log: Checkout, client: EventEmitter): PoolClient {
  const pooled = client as unknown as PoolClient;
  pooled.release = ((...args: unknown[]) => {
    log.releases += 1;
    log.arguments.push(args);
  }) as PoolClient["release"];
  return GuardHeldClient(pooled);
}

describe("a client borrowed from the pool", () => {
  it("swallows an error event that would otherwise end the process", () => {
    const log = Checkouts();
    const client = new EventEmitter();
    expect(() => client.emit(CLIENT_ERROR, new Error(DROPPED))).to.throw(
      DROPPED,
    );
    const held = CheckOut(log, client);
    expect(client.listenerCount(CLIENT_ERROR)).to.equal(1);
    expect(() => client.emit(CLIENT_ERROR, new Error(DROPPED))).to.not.throw();
    held.release();
    expect(client.listenerCount(CLIENT_ERROR)).to.equal(0);
    expect(log.releases).to.equal(1);
  });

  it("accumulates no listeners across repeated checkouts of one client", () => {
    const log = Checkouts();
    const client = new EventEmitter();
    const counts: number[] = [];
    for (let checkout = 0; checkout < CHECKOUTS; checkout += 1) {
      const held = CheckOut(log, client);
      counts.push(client.listenerCount(CLIENT_ERROR));
      held.release();
      counts.push(client.listenerCount(CLIENT_ERROR));
    }
    expect(counts).to.deep.equal([1, 0, 1, 0]);
    expect(log.releases).to.equal(CHECKOUTS);
  });

  it("forwards every argument to the release the checkout installed", () => {
    const log = Checkouts();
    const dropped = new Error(DROPPED);
    CheckOut(log, new EventEmitter()).release(dropped);
    CheckOut(log, new EventEmitter()).release();
    expect(log.arguments).to.deep.equal([[dropped], NO_ARGUMENTS]);
  });
});

/** The pool as the guard sees it: an emitter, which is all `pg.Pool` is for this purpose. */
function Guarded(pool: EventEmitter): EventEmitter {
  return GuardPool(pool as unknown as Pool) as unknown as EventEmitter;
}

describe("the pool a client is idle in", () => {
  it("swallows an error event that would otherwise end the process", () => {
    const pool = new EventEmitter();
    expect(() => pool.emit(CLIENT_ERROR, new Error(DROPPED))).to.throw(DROPPED);
    Guarded(pool);
    expect(pool.listenerCount(CLIENT_ERROR)).to.equal(1);
    expect(() => pool.emit(CLIENT_ERROR, new Error(DROPPED))).to.not.throw();
  });

  it("keeps the listener attached, since the pool outlives every client it lends", () => {
    const pool = new EventEmitter();
    Guarded(pool);
    pool.emit(CLIENT_ERROR, new Error(DROPPED));
    expect(pool.listenerCount(CLIENT_ERROR)).to.equal(1);
    expect(() => pool.emit(CLIENT_ERROR, new Error(DROPPED))).to.not.throw();
  });

  it("answers the pool it guarded, so it composes around the constructor", () => {
    const pool = new EventEmitter();
    expect(Guarded(pool)).to.equal(pool);
  });
});
