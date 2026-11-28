export interface Descriptor {
  summary: string;
  readOnly: boolean;
  limitations: string[];
  required: string[];
  inputs: Record<string, string>;
  example: Record<string, unknown>;
  nodeOnly?: boolean;
  internalOnly?: boolean;
  envelope?: boolean;
  surface?: boolean;
  featureRework?: boolean;
}
export interface ModelingApi {
  catalog: Record<string, Descriptor>;
  validateCad(operation: string, data: unknown): Descriptor;
  buildCadScript(operation: string, data: unknown, context: unknown): string;
  executeCad(
    client: unknown,
    operation: string,
    data: unknown,
    context: unknown,
  ): Promise<{
    status: string;
    success: boolean;
    affected: unknown;
    result: { actual: unknown };
  }>;
}
export interface CurvePlan {
  geometry: { start: string[] }[];
  provenance: { sha256: string };
  loops: unknown[];
  sampleMap: { index: number; point: number[]; line: number; status: string }[];
}
export interface Manual {
  sections: { title: string }[];
  audit: { tests: string[] };
  examples: { data: unknown }[];
}
export interface AuditedManual {
  sections: { title: string; text: string }[];
  audit: {
    sources: string[];
    verified: string[];
    tests: string[];
    gaps: string[];
  };
  examples: {
    label: string;
    requires: string;
    output: string;
    data: unknown;
  }[];
}
export interface NativeRequest {
  object: { readOnly: boolean; script: string };
}

/** Narrow injected service surface exercised by retained public-route fixtures. */
export interface ModelingFixtureServices {
  start(): Promise<void>;
  execute(
    payload: { kind?: string; invocation?: unknown; operation?: string },
    options: { requestId: string },
  ): Promise<ModelingFixtureReceipt>;
  query?: {
    result(jobId: string): Promise<ModelingFixtureReceipt | undefined>;
  };
  dispose?(): Promise<void>;
}
export interface ModelingFixtureReceipt {
  version: number;
  requestId: string;
  jobId: string | null;
  state: string;
  result: unknown;
  outcome: {
    acceptance: string;
    executionOutcome: string;
    validation: { status: string };
  };
}
export interface ModelingFixtureCli {
  main(
    words: string[],
    ports: {
      stdout: { write(text: string): unknown };
      stderr: { write(text: string): unknown };
      loadConfig(): unknown;
      createFmcad?(options: {
        config: { routing?: string };
      }): ModelingFixtureServices;
      createBackend?(): never;
      McpClient?: new () => unknown;
      setExitCode(): void;
    },
  ): Promise<number>;
}
export interface ModelingFixtureMcp {
  createMcpApplication(options: {
    queueTools: unknown[];
    compatibility(): never;
    services(): ModelingFixtureServices;
  }): (request: unknown) => Promise<{
    raw: string;
    artifactOwner?: { jobId: string };
    queueReceipt?: unknown;
  }>;
}
export interface ModelingFixtureStdio {
  startStdio(
    words: string[],
    ports: {
      stdin: import("node:stream").Readable;
      stdout: { write(text: string): unknown };
      stderr: { write(text: string): unknown };
      loadConfig(): unknown;
      createFmcad(): ModelingFixtureServices;
    },
  ): { closed: Promise<void> };
}

// Retained tests inspect untrusted JSON and intentionally invalid requests.
// Keep those boundaries checked at runtime instead of asserting result shapes.
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object in retained modeling evidence");
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new TypeError("Expected an array in retained modeling evidence");
  return value;
}
export function rows(value: unknown): Record<string, unknown>[] {
  return array(value).map(object);
}
export function field(value: unknown, ...keys: (string | number)[]): unknown {
  for (const key of keys)
    value =
      key === "length" && (Array.isArray(value) || typeof value === "string")
        ? value.length
        : typeof key === "number"
          ? array(value)[key]
          : object(value)[key];
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("Expected a string in retained modeling evidence");
  return value;
}
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new TypeError("Expected retained modeling evidence to be present");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(
      "Expected a finite number in retained modeling evidence",
    );
  return value;
}
