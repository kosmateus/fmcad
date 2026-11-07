export interface BrowserConsoleError {
  readonly text: string;
  readonly url: string;
}
export interface ExpectedNetworkFailure {
  readonly url: string;
  readonly error: string;
}

/** Chromium console and requestfailed notifications need not arrive in order. */
export function classifyNetworkConsoleErrors(
  messages: readonly BrowserConsoleError[],
  failures: readonly ExpectedNetworkFailure[],
  origin: string,
): { expected: string[]; unexpected: string[] } {
  const available = new Map<string, number>();
  const key = (url: string, error: string): string =>
    JSON.stringify([url, error]);
  for (const failure of failures) {
    const url = new URL(failure.url);
    if (url.origin !== origin || !url.pathname.startsWith("/api/v1/console/"))
      continue;
    if (
      !/^net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|SOCKET_NOT_CONNECTED)$/u.test(
        failure.error,
      )
    )
      continue;
    const identity = key(failure.url, failure.error);
    available.set(identity, (available.get(identity) ?? 0) + 1);
  }
  const expected: string[] = [],
    unexpected: string[] = [];
  for (const message of messages) {
    const match = /^Failed to load resource: (net::ERR_[A-Z_]+)$/u.exec(
      message.text,
    );
    const identity = key(message.url, match?.[1] ?? "");
    const remaining = available.get(identity) ?? 0;
    if (remaining > 0) {
      available.set(identity, remaining - 1);
      expected.push(message.text);
    } else unexpected.push(message.text);
  }
  return { expected, unexpected };
}
