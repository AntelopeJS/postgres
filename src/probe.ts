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

const REFUSALS = new Map<string, ProbeRefusal>([
  ["28P01", "credentials"],
  ["28000", "host"],
  ["3D000", "database"],
]);

interface AccountRow {
  role: string;
}

/** A client and every socket it opened, which `pg` does not shut when the server ignores its goodbye. */
interface Session {
  client: Client;
  sockets: Socket[];
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
  return { client, sockets };
}

function Shut(session: Session): void {
  for (const socket of session.sockets) {
    socket.destroy();
  }
}

/** Says goodbye and returns at once; a socket the server has not closed after the grace is shut. */
function Close(session: Session): void {
  const timer = setTimeout(() => Shut(session), CLOSE_GRACE_MS);
  timer.unref();
  session.client.end().then(() => clearTimeout(timer), Ignore);
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

async function SignIn(client: Client): Promise<ProbeAnswer> {
  await client.connect();
  const started = performance.now();
  const account = await client.query<AccountRow>(ACCOUNT_SQL);
  const latencyMs = Math.ceil(performance.now() - started);
  const relations = await client.query<RelationRow>(RELATIONS_SQL, [null]);
  return {
    outcome: "signed-in",
    latencyMs,
    user: account.rows[0].role,
    ...Privileges(relations.rows.map(AccessOf)),
  };
}

function Failure(err: unknown): ProbeAnswer {
  if (err instanceof DatabaseError) {
    const refusal = (err.code && REFUSALS.get(err.code)) || "other";
    return { outcome: "refused", refusal, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { outcome: "unreachable", message };
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
 * shuts every socket at once, or opens none, and answers {@link AbortedAnswer} whatever the server said.
 */
export const probe: Probe = async ({ url, timeoutMs, signal }) => {
  if (signal.aborted) {
    return AbortedAnswer();
  }
  let session: Session | undefined;
  const aborted = WhenAborted(signal, () => session && Shut(session));
  try {
    session = Open(url, timeoutMs);
    return await Promise.race([
      SignIn(session.client).catch(Failure),
      aborted.answer,
    ]);
  } catch (err) {
    return Failure(err);
  } finally {
    aborted.withdraw();
    if (session) {
      Close(session);
    }
  }
};
