import type { ConnectionOptions } from "node:tls";

/**
 * The TLS setting `pg` connects with: off, on, its options, or a value it did not convert, which a
 * URL gives as text and a programmatic `pool.ssl` as any primitive.
 */
export type ConnectionSsl =
  | boolean
  | string
  | number
  | bigint
  | symbol
  | ConnectionOptions
  | null
  | undefined;

declare module "pg" {
  interface Client {
    /**
     * What `pg` 8 connects with: the client's config with every parameter of its connection
     * string assigned over it, after `pg`'s own conversions, so a URL parameter wins over the
     * config it names.
     */
    connectionParameters: ConnectionParameters;
  }
}

/** The fields of `pg`'s `ConnectionParameters` this module reads or sets. */
export interface ConnectionParameters {
  ssl: ConnectionSsl;
  query_timeout: number | false | undefined;
  statement_timeout: number | false | undefined;
  lock_timeout: number | false | undefined;
  idle_in_transaction_session_timeout: number | false | undefined;
  replication: string | boolean | undefined;
}

/** A primitive `pg` cannot read as a TLS setting: it reads only `true`, an object or a falsy value. */
export type UnusableSsl = string | number | bigint | symbol;

const UNUSABLE_SSL_KINDS = new Set(["string", "number", "bigint", "symbol"]);

/**
 * Whether `pg` throws on `ssl` once the server accepts TLS: a truthy primitive other than `true`.
 * It throws inside a socket event, where no promise catches it and the process exits.
 */
export function IsUnusableSsl(ssl: ConnectionSsl): ssl is UnusableSsl {
  return Boolean(ssl) && UNUSABLE_SSL_KINDS.has(typeof ssl);
}
