import { Client } from "pg";

import { Logger } from "../../logger";
import { QuoteIdentifier } from "./sql";
import { GetOptions } from "../../config";
import { CHANGE_CHANNEL } from "./changes";
import { RegisterBeforeDisconnect } from "../../connection";

/**
 * What a notification means to a feed: this target changed, or everything may have.
 *
 * The second is what a reconnect broadcasts. Notifications raised while the connection was down are
 * gone and there is no way to ask for them, so a feed must re-read from its watermark rather than
 * wait for a wakeup that will never come — which the watermark makes both safe and idempotent.
 */
export type ChangeSubscriber = (target?: string) => void;

const NOTIFICATION = "notification";
const ERROR = "error";

const LISTEN = `LISTEN ${QuoteIdentifier(CHANGE_CHANNEL)}`;

const FIRST_BACKOFF_MS = 50;
const LARGEST_BACKOFF_MS = 5_000;
const BACKOFF_FACTOR = 2;

const LISTENER_FAILED =
  "the PostgreSQL change listener's connection failed and is being re-established";

const subscribers = new Set<ChangeSubscriber>();

let listening: Promise<void> | undefined;
let client: Client | undefined;
let backoffMs = FIRST_BACKOFF_MS;
let retry: NodeJS.Timeout | undefined;
let isStopped = false;

/** Adds a subscriber and answers the function that withdraws it again. */
export function SubscribeToChanges(subscriber: ChangeSubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

function Announce(target?: string) {
  for (const subscriber of subscribers) {
    subscriber(target);
  }
}

/** Tells every feed to re-read: anything raised while the connection was down is gone. */
function CaughtUp() {
  Announce();
}

function Connected(created: Client): Promise<void> {
  return created.connect().then(() => {
    void created.query(LISTEN);
  });
}

/** Re-listens, then tells every feed to catch up, since anything raised while down is lost. */
function Reconnect() {
  if (isStopped || retry) {
    return;
  }
  retry = setTimeout(() => {
    retry = undefined;
    listening = Establish().then(CaughtUp, () => {
      backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, LARGEST_BACKOFF_MS);
      Reconnect();
    });
  }, backoffMs);
  retry.unref();
}

function Failed(err: unknown) {
  Logger.Warn(LISTENER_FAILED, err);
  client = undefined;
  Reconnect();
}

async function Establish(): Promise<void> {
  const created = new Client({ connectionString: GetOptions().url });
  created.on(ERROR, Failed);
  created.on(NOTIFICATION, (message) => {
    Announce(message.payload);
  });
  await Connected(created);
  client = created;
  backoffMs = FIRST_BACKOFF_MS;
}

/**
 * Opens the one `LISTEN` connection this process shares between every feed, once.
 *
 * **Not a pooled client.** It is held for the lifetime of the process, and a pooled client that is
 * never returned makes `pool.end()` hang rather than fail, as a held cursor client does. It carries
 * its own `error` handler for the same reason every borrowed client does: an `error` event on an
 * `EventEmitter` with no listener ends the host process, and a dropped connection is exactly the
 * event this one exists to survive.
 *
 * Awaited by a feed's *first* read rather than left to settle in the background, because the window
 * between a feed opening and its `LISTEN` landing is a window in which a notification is missed —
 * costing that feed a whole fallback interval to notice a write that had already happened.
 *
 * A failure here is not fatal to a feed: the watermark is the correctness mechanism and this is
 * only latency, so a feed whose listener never came up still delivers on its fallback poll.
 */
export function EnsureListening(): Promise<void> {
  isStopped = false;
  if (!listening) {
    listening = Establish().catch(Failed);
  }
  return listening;
}

/** Ends the listener; registered below so `Disconnect` closes it rather than leaving it open. */
async function StopListening(): Promise<void> {
  isStopped = true;
  if (retry) {
    clearTimeout(retry);
    retry = undefined;
  }
  const open = client;
  client = undefined;
  listening = undefined;
  backoffMs = FIRST_BACKOFF_MS;
  if (open) {
    await open.end().catch(() => undefined);
  }
}

RegisterBeforeDisconnect(StopListening);
