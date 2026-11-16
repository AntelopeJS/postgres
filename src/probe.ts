import { Socket } from "node:net";

import type {
  Probe,
  ProbeAnswer,
  ProbeRefusal,
} from "@antelopejs/interface-database-catalog";
import { Client, DatabaseError } from "pg";

import {
  AccessOf,
  PRIVILEGES_SQL,
  type RelationAccess,
  type RelationPrivileges,
} from "./implementations/database/external-access";
import { OverrideParameters, SslRefusal } from "./probe-parameters";
import { ReadUrl } from "./probe-url";

/** How long a client may take to close before its sockets are shut. */
const CLOSE_GRACE_MS = 250;

const ACCOUNT_SQL = "SELECT current_user AS role";

/** Holds the listing to reads, whatever functions the session's `search_path` resolves to. */
const READ_ONLY_SQL = "BEGIN TRANSACTION READ ONLY";

/**
 * Whether the role may create a table in the database: in a schema that grants it `CREATE`, or in
 * a schema the database lets it create. `pg_temp_*` and `pg_toast` are left out with the rest of `pg_*`.
 */
const CREATES_SQL = `SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
        AND pg_catalog.has_schema_privilege(n.oid, 'CREATE')
    ) AS creates`;

const ABORTED = "The probe was aborted.";

/** What a server error during the sign-in refuses. Any other code is `other`. */
const REFUSALS = new Map<string, ProbeRefusal>([
  ["28P01", "credentials"],
  ["28000", "host"],
  ["3D000", "database"],
  ["42501", "database-denied"],
]);

const PASSWORD_REQUIRED =
  "the server asks for a password the URL does not give";

/** Thrown instead of answering a password request the URL has no password for. */
class PasswordRequired extends Error {
  constructor() {
    super(PASSWORD_REQUIRED);
  }
}

type SignedIn = Extract<ProbeAnswer, { outcome: "signed-in" }>;

interface AccountRow {
  role: string;
}

interface CreatesRow {
  creates: boolean;
}

/** A client and every socket it opened, which `pg` does not shut when the server ignores its goodbye. */
interface Session {
  client: Client;
  sockets: Socket[];
}

function Ignore(): void {
  return undefined;
}

function WithholdPassword(): never {
  throw new PasswordRequired();
}

/**
 * Opens a client on `url` as the driver's pool reads it, TLS settings included, except for the
 * parameters `OverrideParameters` sets and the password, which is the URL's own: one it lacks is
 * never filled in from `PGPASSWORD` or `.pgpass`, which would send the probing process's own
 * secret to the host the URL names.
 */
function Open(
  url: string,
  password: string | undefined,
  timeoutMs: number,
): Session {
  const sockets: Socket[] = [];
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    stream: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  OverrideParameters(client, timeoutMs);
  Object.defineProperty(client, "password", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: password || WithholdPassword,
  });
  client.on("error", Ignore);
  return { client, sockets };
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

/**
 * The probe's rule over the catalog's per-relation access: any relation decides, none reads. The
 * right to create a table writes too, so an empty database the role may build in is not read-only.
 */
function Privileges(access: RelationAccess[], creates: boolean) {
  return {
    canRead:
      access.length === 0 ||
      access.some(({ unmappable }) => unmappable === undefined),
    canWrite:
      creates ||
      access.some(
        ({ writes }) => writes.insert || writes.update || writes.delete,
      ),
  };
}

/** An error's message, or its causes' when it has none: Node's for every address of a host refusing. */
function MessageOf(err: Error): string {
  if (err.message || !(err instanceof AggregateError)) {
    return err.message;
  }
  return err.errors
    .map((cause) =>
      MessageOf(cause instanceof Error ? cause : new Error(String(cause))),
    )
    .join("; ");
}

function Unanswered(err: Error): ProbeAnswer {
  return { outcome: "unreachable", message: MessageOf(err) };
}

/** A failed sign-in: the server's refusal, a password the server asked for and the URL lacks, or no answer. */
function Refusal(err: Error): ProbeAnswer {
  if (err instanceof DatabaseError) {
    const refusal = (err.code && REFUSALS.get(err.code)) || "other";
    return { outcome: "refused", refusal, message: err.message };
  }
  if (err instanceof PasswordRequired) {
    return {
      outcome: "refused",
      refusal: "sign-in-required",
      message: err.message,
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
    await client.query(READ_ONLY_SQL);
    const relations = await client.query<RelationPrivileges>(PRIVILEGES_SQL, [
      null,
    ]);
    const creates = await client.query<CreatesRow>(CREATES_SQL);
    return {
      ...answer,
      ...Privileges(relations.rows.map(AccessOf), creates.rows[0].creates),
    };
  } catch (err) {
    if (!(err instanceof DatabaseError)) {
      return Unanswered(err instanceof Error ? err : new Error(String(err)));
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
    return Refusal(err instanceof Error ? err : new Error(String(err)));
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
 * catalog's `ListRelations` sees, judged per relation as the catalog judges them, and whether it
 * may create a table in the database, which counts as write access. Every client it
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
    const reading = ReadUrl(url);
    if (reading.kind === "refused") {
      return { outcome: "refused", refusal: "other", message: reading.message };
    }
    session = Open(url, reading.url.password, timeoutMs);
    const sslRefusal = SslRefusal(session.client);
    if (sslRefusal) {
      return { outcome: "refused", refusal: "other", message: sslRefusal };
    }
    return await Promise.race([SignIn(session), aborted.answer]);
  } catch (err) {
    return Unanswered(err instanceof Error ? err : new Error(String(err)));
  } finally {
    aborted.withdraw();
    if (session) {
      Close(session, signal);
    }
  }
};
