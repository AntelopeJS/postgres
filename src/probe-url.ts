import { closeSync, openSync, readSync, statSync } from "node:fs";

import { type ConnectionOptions, parse } from "pg-connection-string";

/** Larger than any CA bundle, small enough to read at once. */
const MAX_ROOT_CERTIFICATE_BYTES = 1 << 20;

/** The first character code past the C0 controls. */
const FIRST_PRINTABLE = 0x20;

const CONTROL_REFUSAL =
  "the URL contains a control character, which the URL parser would remove or trim";

const CLIENT_CERTIFICATE =
  "the URL presents a client certificate of the probing host (sslcert, sslkey), which the probe never sends";

const ROOT_CERTIFICATE =
  "the URL's sslrootcert is not a regular file of at most 1 MiB the probe can read";

const NO_USER =
  "the URL names no user, and the probe signs in as no user of the probing process";

const NO_HOST =
  "the URL names no host, and the probe sends credentials to no host the URL does not name";

/** A URL the probe signs in with, or why it will not. */
export type UrlReading =
  | { kind: "refused"; message: string }
  | { kind: "read"; url: ConnectionOptions };

/**
 * The URL's query parameters as `pg-connection-string` reads them: everything after the first
 * `?`, up to a `#`. It decodes no more than the parser does, so a parameter it reads is found here.
 */
function QueryOf(url: string): URLSearchParams {
  const query = url.indexOf("?");
  const fragment = url.indexOf("#");
  if (query < 0 || (fragment >= 0 && fragment < query)) {
    return new URLSearchParams();
  }
  return new URLSearchParams(
    url.slice(query + 1, fragment > query ? fragment : undefined),
  );
}

/** Whether `url` holds a C0 control: the URL parser drops tab, CR and LF and trims the rest at the ends. */
function HasControlCharacter(url: string): boolean {
  for (let index = 0; index < url.length; index += 1) {
    if (url.charCodeAt(index) < FIRST_PRINTABLE) {
      return true;
    }
  }
  return false;
}

/** Whether reading `descriptor` to its end takes at most `limit` bytes, never trusting its size. */
function EndsWithin(descriptor: number, limit: number): boolean {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  while (total <= limit) {
    const read = readSync(descriptor, buffer, total, limit + 1 - total, null);
    if (read === 0) {
      return true;
    }
    total += read;
  }
  return false;
}

/**
 * Whether `path` is a regular file that ends within the limit when read. Its reported size is not
 * trusted: a `/proc` file reports 0 and can return gigabytes.
 */
function IsSmallRegularFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    const descriptor = openSync(path, "r");
    try {
      return EndsWithin(descriptor, MAX_ROOT_CERTIFICATE_BYTES);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

/**
 * Why the parser must not see the URL: it would read a client certificate of the probing host, or
 * read a CA file without bound (a device, a FIFO, a huge file) and block the event loop before
 * `timeoutMs` or the signal could stop it.
 */
function FileRefusal(query: URLSearchParams): string | undefined {
  if (query.has("sslcert") || query.has("sslkey")) {
    return CLIENT_CERTIFICATE;
  }
  const roots = query.getAll("sslrootcert").filter((path) => path !== "");
  return roots.every(IsSmallRegularFile) ? undefined : ROOT_CERTIFICATE;
}

/** Why the parsed URL would sign in with the probing process's user name or host. */
function IdentityRefusal(url: ConnectionOptions): string | undefined {
  if (!url.user) {
    return NO_USER;
  }
  return url.host ? undefined : NO_HOST;
}

/**
 * Reads `url` as the driver does, once nothing in it can make the parser block or take a
 * credential, a user name or a host from the probing host.
 */
export function ReadUrl(url: string): UrlReading {
  if (HasControlCharacter(url)) {
    return { kind: "refused", message: CONTROL_REFUSAL };
  }
  const fileRefusal = FileRefusal(QueryOf(url));
  if (fileRefusal) {
    return { kind: "refused", message: fileRefusal };
  }
  const parsed = parse(url);
  const identityRefusal = IdentityRefusal(parsed);
  return identityRefusal
    ? { kind: "refused", message: identityRefusal }
    : { kind: "read", url: parsed };
}
