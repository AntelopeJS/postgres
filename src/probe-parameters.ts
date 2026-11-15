import type { ConnectionOptions } from "node:tls";

import type { Client } from "pg";

declare module "pg" {
  interface Client {
    /**
     * What `pg` 8 connects with: the client's config with every parameter of its connection
     * string assigned over it, so a URL parameter wins over the config it names.
     */
    connectionParameters: ConnectionParameters;
  }
}

/** The TLS setting `pg` connects with: off, on, its options, or text it did not convert. */
type ConnectionSsl = boolean | string | ConnectionOptions | undefined;

/** The fields of `pg`'s `ConnectionParameters` the probe reads or sets after the URL is merged. */
interface ConnectionParameters {
  ssl: ConnectionSsl;
  query_timeout: number | false | undefined;
  statement_timeout: number | false | undefined;
  lock_timeout: number | false | undefined;
  idle_in_transaction_session_timeout: number | false | undefined;
  replication: string | boolean | undefined;
}

/**
 * How the probe treats one field of `pg`'s `ConnectionParameters`, which is where every
 * connection-string parameter `pg` 8.22 and `pg-connection-string` 2.14 honour ends up.
 *
 * - `url`: the URL decides, as it does for the driver's own pool.
 * - `probe`: the probe decides, whatever the URL says, because the URL could loosen a bound or
 *   change what kind of session the probe opens.
 * - `inert`: `pg`'s JavaScript client never reads it from a URL: only `pg-native` uses it, or the
 *   client takes it from its own config.
 */
export type ParameterHandling = "url" | "probe" | "inert";

/** Every field of `pg`'s `ConnectionParameters`, with how the probe treats it. */
export const CONNECTION_PARAMETERS: ReadonlyMap<string, ParameterHandling> =
  new Map<string, ParameterHandling>([
    ["user", "url"],
    ["database", "url"],
    ["port", "url"],
    ["host", "url"],
    ["isDomainSocket", "url"],
    ["password", "url"],
    ["options", "url"],
    ["ssl", "url"],
    ["sslnegotiation", "url"],
    ["client_encoding", "url"],
    ["application_name", "url"],
    ["fallback_application_name", "url"],
    ["query_timeout", "probe"],
    ["statement_timeout", "probe"],
    ["lock_timeout", "probe"],
    ["idle_in_transaction_session_timeout", "probe"],
    ["replication", "probe"],
    ["binary", "inert"],
    ["connect_timeout", "inert"],
    ["keepalives", "inert"],
    ["keepalives_idle", "inert"],
  ]);

/**
 * Sets every `probe` parameter after `pg` has merged the URL over the client's config: each bound
 * to `timeoutMs`, and no replication session, whose protocol cannot read the catalog.
 */
export function OverrideParameters(client: Client, timeoutMs: number): void {
  Object.assign(client.connectionParameters, {
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    lock_timeout: timeoutMs,
    idle_in_transaction_session_timeout: timeoutMs,
    replication: undefined,
  } satisfies Omit<ConnectionParameters, "ssl">);
}

const SSL_TEXT =
  "the URL's ssl value is none of true, 1, 0, empty or no-verify, and pg fails on it once the server accepts TLS";

/** Whether `pg` kept `ssl` as text, which it reads only when empty. */
function IsSslText(ssl: ConnectionSsl): ssl is string {
  return typeof ssl === "string";
}

/**
 * Why `client` must not connect: `pg` resolved its `ssl` to text it does not convert, and once the
 * server accepts TLS it throws on that text inside a socket event, where no promise catches it.
 */
export function SslRefusal(client: Client): string | undefined {
  const { ssl } = client.connectionParameters;
  return IsSslText(ssl) && ssl !== "" ? SSL_TEXT : undefined;
}
