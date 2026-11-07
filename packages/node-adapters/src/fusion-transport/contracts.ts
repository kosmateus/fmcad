import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type ObjectValue = Record<string, unknown>;
export interface Server {
  readonly url: string;
  readonly backend?: string;
  readonly transport?: string;
  readonly tool?: string;
  readonly protocolVersion?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly curlPath?: string;
}
export interface Response {
  readonly status: number;
  readonly sessionId?: string | undefined;
  readonly raw: string;
}
/** Local preparation may fail; checking a prepared call never opens a session. */
export interface PreparedPost {
  fence(): void;
  send(sessionId?: string): Promise<Response>;
}
export interface PreparedToolCall {
  (): Promise<ToolResult>;
  fence(): void;
}
export interface RequestOptions {
  readonly sessionId?: string | undefined;
  readonly protocolVersion?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}
export interface RequestOverrides {
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocolVersion?: string | undefined;
}
export interface ToolResult {
  text: string;
  failed: boolean;
  data: unknown;
  stderr?: unknown;
  uiGuard?: unknown;
  backend?: string;
  readOnlyRequested?: boolean;
  readOnlyEnforced?: boolean;
}
export interface Dependencies {
  readonly version: string;
  readonly bridgeSource: () => string;
  readonly requestTimeout: (server: Server) => number;
  readonly spawn?: typeof spawn | undefined;
}
export type Spawn = (
  executable: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
export function parse(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) return parseJson(text);
  // SSE events may span several data lines. Select the last JSON-RPC response,
  // not an unrelated trailing notification or heartbeat.
  let response: unknown = null;
  let last: unknown = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const value = parseJson(data);
    last = value;
    if (Object.hasOwn(object(value), "id")) response = value;
  }
  if (response === null && last === null)
    throw unknownOutcome("Missing MCP response event", "EPROTO");
  return response ?? last;
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unknownOutcome("Malformed backend JSON response", "EPROTO");
  }
}
export function unknownOutcome(
  message: string,
  code: string,
): Error & { code: string } {
  return Object.assign(
    new Error(`${message}; outcome unknown; inspect before retry`),
    { code },
  );
}
