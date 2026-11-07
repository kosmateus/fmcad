export interface DiagnosticBackend {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const sensitiveName =
  /^(?:access_token|refresh_token|token|api[_-]?key|key|secret|password|signature|sig|credential)$/i;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function urlSecrets(value: string): string[] {
  const secrets: string[] = [];
  const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (authority) {
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userInfo = authority.slice(0, at);
      const colon = userInfo.indexOf(":");
      const user = colon < 0 ? userInfo : userInfo.slice(0, colon);
      const password = colon < 0 ? "" : userInfo.slice(colon + 1);
      secrets.push(user, password, decoded(user), decoded(password));
    }
  }
  const query = value.split("#", 1)[0]?.split("?", 2)[1];
  if (query)
    for (const part of query.split("&")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      if (sensitiveName.test(decoded(part.slice(0, separator))))
        secrets.push(decoded(part.slice(separator + 1)));
    }
  return secrets;
}

export function redactDiagnostic(
  value: unknown,
  backend: DiagnosticBackend = {},
): string {
  let text = String(value);
  const secrets = Object.entries(backend.headers ?? {})
    .filter(
      ([name]) => !/^(host|accept|content-type|content-length)$/i.test(name),
    )
    .flatMap(([, secret]) => [
      String(secret),
      String(secret).replace(/^(Bearer|Basic)\s+/i, ""),
    ]);
  if (backend.url) {
    text = text.split(backend.url).join("[REDACTED URL]");
    secrets.push(...urlSecrets(backend.url));
  }
  for (const secret of [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(
      /^([ \t]*(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|mcp-session-id|access_token|refresh_token|client_secret|password|api_key|secret)[ \t]*[:=][ \t]*)(?:\r?\n)?[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gim,
      (_match, prefix: string) => prefix + "[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      url
        .replace(/(https?:\/\/)[^/]*@/i, "$1[REDACTED]@")
        .replace(
          /([?&#](?:access_token|refresh_token|token|api[_-]?key|key|secret|password|signature|sig|credential)=)[^&#]*/gi,
          "$1[REDACTED]",
        ),
    )
    .replace(
      /((?:["']?)(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|mcp-session-id|access_token|refresh_token|client_secret|password|api_key|secret)["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\r\n,"'}]+)/gi,
      (_match, prefix: string, raw: string) =>
        prefix +
        (/^["'][^"'\r\n]+["']\s*:/.test(prefix) || raw.startsWith('"')
          ? '"[REDACTED]"'
          : raw.startsWith("'")
            ? "'[REDACTED]'"
            : "[REDACTED]"),
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+\/_=~-]+/gi, "$1 [REDACTED]");
}

export function formatJsonError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const location = message.match(
    / at position (\d+)(?: \(line (\d+) column (\d+)\))?$/,
  );
  if (location)
    return (
      `Invalid JSON at position ${location[1]}` +
      (location[2] ? ` (line ${location[2]} column ${location[3]})` : "")
    );
  const line = message.match(/(?: at | \()line (\d+) column (\d+)\)?$/);
  return "Invalid JSON" + (line ? ` (line ${line[1]} column ${line[2]})` : "");
}
