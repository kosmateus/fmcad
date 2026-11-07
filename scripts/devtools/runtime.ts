import path from "node:path";
import { createRequire } from "node:module";

export const runtimeRoot = path.resolve(__dirname, "../../..");
export const runtimeRequire = createRequire(__filename);

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error["code"] === "string" ? error["code"] : undefined;
}
