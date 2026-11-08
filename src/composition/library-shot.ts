import * as fs from "node:fs";

export interface ShotOutput {
  data?: unknown;
  text?: string;
  failed?: boolean;
}
export interface ShotClient {
  callTool(args: Record<string, unknown>, tool: string): Promise<ShotOutput>;
}
export interface ShotIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}
export interface ShotFiles {
  writeFileSync(file: string, bytes: Uint8Array): unknown;
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;
}

export function findBase64(text: string | undefined): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text as string);
  } catch {
    return null;
  }
  const value = object(parsed);
  if (!value) return null;
  if (value["base64Data"]) return value["base64Data"];
  if (value["data"]) return value["data"];
  const result = object(value["result"]);
  if (result?.["base64Data"]) return result["base64Data"];
  const content = value["content"] || result?.["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      // Preserve legacy malformed-item failures instead of silently skipping them.
      const entry = item as JsonObject;
      if (entry["type"] === "image" && entry["data"]) return entry["data"];
      if (entry["base64Data"]) return entry["base64Data"];
    }
  }
  return null;
}

/** Dedicated legacy command adapter. docops.js wiring is owned by sol-documents. */
export async function shotCmd(
  client: ShotClient,
  args: readonly string[],
  io: ShotIo = process,
  files: ShotFiles = fs,
  now: () => number = Date.now,
): Promise<number> {
  let outFile: string | undefined;
  const callArgs: Record<string, unknown> = { queryType: "screenshot" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") outFile = args[++i];
    else if (arg === "--dir") callArgs["direction"] = args[++i];
    else if (arg === "--width") callArgs["width"] = Number(args[++i]);
    else if (arg === "--height") callArgs["height"] = Number(args[++i]);
    else if (arg === "--no-aa") callArgs["antiAliasing"] = false;
    else if (arg === "--transparent") callArgs["transparentBackground"] = true;
  }
  const output = await client.callTool(callArgs, "fusion_mcp_read");
  const base64 =
    findBase64(JSON.stringify(output.data || {})) || findBase64(output.text);
  if (output.failed) {
    io.stderr.write("ERROR screenshot failed: " + output.text + "\n");
    return 1;
  }
  if (!base64) {
    io.stderr.write("ERROR no image data in screenshot response\n");
    return 1;
  }
  const file = outFile || `shot-${now()}.png`;
  const bytes = Buffer.from(base64 as string, "base64");
  files.writeFileSync(file, bytes);
  io.stdout.write(`SHOT path=${file} bytes=${bytes.length}\n`);
  return 0;
}
