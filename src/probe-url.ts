import { type ConnectionOptions, parse } from "pg-connection-string";

/** The first character code past the C0 controls. */
const FIRST_PRINTABLE = 0x20;

const CONTROL_REFUSAL =
  "the URL contains a control character, which the URL parser would remove or trim";

const CLIENT_CERTIFICATE =
  "the URL presents a client certificate of the probing host (sslcert, sslkey), which the probe never sends";

const ROOT_CERTIFICATE =
  "the URL names a CA file of the probing host (sslrootcert), and the probe reads no file: a read of one cannot be bounded in time";

const SSL_VALUE =
  "the URL's ssl value is none of true, 1, 0 or no-verify, and pg fails on it once the server accepts TLS";

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

/**
 * Why the parser must not see the URL: it would read a file of the probing host synchronously, a
 * client certificate that must not be sent or a CA file whose read no time bound can stop.
 */
function FileRefusal(query: URLSearchParams): string | undefined {
  if (query.has("sslcert") || query.has("sslkey")) {
    return CLIENT_CERTIFICATE;
  }
  return query.has("sslrootcert") ? ROOT_CERTIFICATE : undefined;
}

/** Whether the parser left `ssl` as the URL's own text, which only `no-verify` may be. */
function IsSslText(ssl: ConnectionOptions["ssl"]): ssl is string {
  return typeof ssl === "string";
}

/**
 * Why the parsed URL cannot be used: `pg` would throw outside any promise on an `ssl` text it does
 * not know once the server accepts TLS, or sign in with the probing process's user name or host.
 */
function ParsedRefusal(url: ConnectionOptions): string | undefined {
  if (IsSslText(url.ssl) && url.ssl !== "no-verify") {
    return SSL_VALUE;
  }
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
  const query = QueryOf(url);
  const queryRefusal = FileRefusal(query);
  if (queryRefusal) {
    return { kind: "refused", message: queryRefusal };
  }
  const parsed = parse(url);
  const parsedRefusal = ParsedRefusal(parsed);
  return parsedRefusal
    ? { kind: "refused", message: parsedRefusal }
    : { kind: "read", url: parsed };
}
