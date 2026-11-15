import { Socket } from "node:net";

import type {
  Probe,
  ProbeAnswer,
  ProbeRefusal,
} from "@antelopejs/interface-database-catalog";
import { Client, DatabaseError } from "pg";

import {
  AccessOf,
  RELATIONS_SQL,
  type RelationAccess,
  type RelationRow,
} from "./implementations/database/external-access";

/** How long a client may take to close before its sockets are shut. */
const CLOSE_GRACE_MS = 250;

const ACCOUNT_SQL = "SELECT current_user AS role";

const ABORTED = "The probe was aborted.";

/** What a server error during the sign-in refuses. Any other code is `other`. */
const REFUSALS = new Map<string, ProbeRefusal>([
  ["28P01", "credentials"],
  ["28000", "host"],
  ["3D000", "database"],
  ["42501", "database-denied"],
]);

/** The `pg` connection events of a server asking the client for a password. */
const PASSWORD_REQUESTS = [
  "authenticationCleartextPassword",
  "authenticationMD5Password",
  "authenticationSASL",
];

type SignedIn = Extract<ProbeAnswer, { outcome: "signed-in" }>;

interface AccountRow {
  role: string;
}

/**
 * A client, every socket it opened, which `pg` does not shut when the server ignores its goodbye,
 * and whether the server asked it for a password.
 */
interface Session {
  client: Client;
  sockets: Socket[];
  askedPassword: boolean;
}

function Ignore(): void {
  return undefined;
}

function Open(url: string, timeoutMs: number): Session {
  const sockets: Socket[] = [];
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    stream: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  client.on("error", Ignore);
  const session = { client, sockets, askedPassword: false };
  for (const request of PASSWORD_REQUESTS) {
    client.connection.once(request, () => {
      session.askedPassword = true;
    });
  }
  return session;
}

function Shut(session: Session): void {
  for (const socket of session.sockets) {
    socket.destroy();
  }
}

/**
 * Says goodbye and returns at once. A socket the server has not closed after the grace is shut,
 * and so is every socket at once when `signal` aborts first.
 */
function Close(session: Session, signal: AbortSignal): void {
  if (signal.aborted) {
    Shut(session);
    return;
  }
  const settle = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", shut);
  };
  const shut = () => {
    settle();
    Shut(session);
  };
  const timer = setTimeout(shut, CLOSE_GRACE_MS);
  timer.unref();
  signal.addEventListener("abort", shut, { once: true });
  session.client.end().then(settle, Ignore);
}

/** The probe's rule over the catalog's per-relation access: any relation decides, none reads. */
function Privileges(access: RelationAccess[]) {
  return {
    canRead:
      access.length === 0 ||
      access.some(({ unmappable }) => unmappable === undefined),
    canWrite: access.some(
      ({ writes }) => writes.insert || writes.update || writes.delete,
    ),
  };
}

/** An error's message, or its causes' when it has none: Node's for every address of a host refusing. */
function MessageOf(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (err.message || !(err instanceof AggregateError)) {
    return err.message;
  }
  const causes: unknown[] = err.errors;
  return causes.map(MessageOf).join("; ");
}

function Unanswered(err: unknown): ProbeAnswer {
  return { outcome: "unreachable", message: MessageOf(err) };
}

/** A failed sign-in: the server's refusal, a password the server asked for and the URL lacks, or no answer. */
function Refusal(err: unknown, session: Session): ProbeAnswer {
  if (err instanceof DatabaseError) {
    const refusal = (err.code && REFUSALS.get(err.code)) || "other";
    return { outcome: "refused", refusal, message: err.message };
  }
  if (session.askedPassword) {
    return {
      outcome: "refused",
      refusal: "sign-in-required",
      message: MessageOf(err),
    };
  }
  return Unanswered(err);
}

/** Reads the account and the relations it sees; a server error past the sign-in is `cannot-list`. */
async function Read(client: Client): Promise<ProbeAnswer> {
  const started = performance.now();
  const answer: SignedIn = {
    outcome: "signed-in",
    latencyMs: 0,
    canRead: false,
    canWrite: false,
  };
  try {
    const account = await client.query<AccountRow>(ACCOUNT_SQL);
    answer.latencyMs = Math.ceil(performance.now() - started);
    answer.user = account.rows[0].role;
    const relations = await client.query<RelationRow>(RELATIONS_SQL, [null]);
    return { ...answer, ...Privileges(relations.rows.map(AccessOf)) };
  } catch (err) {
    if (!(err instanceof DatabaseError)) {
      return Unanswered(err);
    }
    const latencyMs =
      answer.latencyMs || Math.ceil(performance.now() - started);
    return { ...answer, latencyMs, unreadable: "cannot-list" };
  }
}

async function SignIn(session: Session): Promise<ProbeAnswer> {
  try {
    await session.client.connect();
  } catch (err) {
    return Refusal(err, session);
  }
  return Read(session.client);
}

function AbortedAnswer(): ProbeAnswer {
  return { outcome: "unreachable", message: ABORTED };
}

/** Settles with {@link AbortedAnswer} once `signal` aborts, and withdraws its listener when told to. */
function WhenAborted(signal: AbortSignal, onAbort: () => void) {
  let withdraw = Ignore;
  const answer = new Promise<ProbeAnswer>((resolve) => {
    const abort = () => {
      onAbort();
      resolve(AbortedAnswer());
    };
    signal.addEventListener("abort", abort, { once: true });
    withdraw = () => signal.removeEventListener("abort", abort);
  });
  return { answer, withdraw };
}

/**
 * Signs in to PostgreSQL with `pg` and answers what the account may do over the relations the
 * catalog's `ListRelations` sees, judged per relation as the catalog judges them. Every client it
 * opens is closed once it answers. When `signal` aborts before then, or has already aborted, it
 * shuts every socket at once, or opens none, and answers {@link AbortedAnswer} whatever the server
 * said. An abort during the close shuts every socket at once too.
 */
export const probe: Probe = async ({ url, timeoutMs, signal }) => {
  if (signal.aborted) {
    return AbortedAnswer();
  }
  let session: Session | undefined;
  const aborted = WhenAborted(signal, () => session && Shut(session));
  try {
    session = Open(url, timeoutMs);
    return await Promise.race([SignIn(session), aborted.answer]);
  } catch (err) {
    return Unanswered(err);
  } finally {
    aborted.withdraw();
    if (session) {
      Close(session, signal);
    }
  }
};
