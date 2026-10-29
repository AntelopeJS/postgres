const DEFAULT_PORT = "5432";

const UNANSWERED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]);

const SSL_REQUIRED_MARKER = "no encryption";

function Endpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || DEFAULT_PORT}`;
  } catch {
    return "the configured host";
  }
}

function Sentence(
  code: string,
  message: string,
  url: string,
): string | undefined {
  if (code === "28P01") {
    return "wrong user or password";
  }
  if (code === "3D000") {
    return "the database does not exist";
  }
  if (UNANSWERED_CODES.has(code)) {
    return `the server is not answering at ${Endpoint(url)}`;
  }
  if (code === "28000" && message.includes(SSL_REQUIRED_MARKER)) {
    return "the server requires SSL";
  }
  return undefined;
}

/**
 * Words a failed first connection for the person who configured `url`, keeping the original code.
 *
 * A wrong password, a missing database, a server that does not answer and a server that requires
 * SSL each read as one sentence; anything else keeps the driver's own message.
 */
export function DescribeConnectFailure(err: Error, url: string): string {
  const code = "code" in err ? String(err.code) : undefined;
  if (!code) {
    return err.message;
  }
  const sentence = Sentence(code, err.message, url) ?? err.message;
  return `${sentence} (${code})`;
}
