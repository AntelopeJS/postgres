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
     * string assigned over it, after `pg`'s own conversions.
     */
    connectionParameters: ConnectionParameters;
  }
}

/** The fields of `pg`'s `ConnectionParameters` this module reads. */
interface ConnectionParameters {
  ssl: ConnectionSsl;
}
