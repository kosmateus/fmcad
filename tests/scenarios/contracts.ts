export type Protocol = "mcp" | "addin";
export interface Owner {
  readonly runId: string;
  readonly scenarioId: string;
  readonly clientId: string;
}
export interface Document {
  readonly creationId: string;
  readonly name: string;
  readonly file?: SavedFile;
}
export interface FixtureFolder {
  readonly projectId: string;
  readonly folderId: string;
}
export interface SavedFile extends FixtureFolder {
  readonly fileId: string;
  readonly version: number;
}
export interface ScriptRequest {
  readonly owner: Owner;
  readonly requestId: string;
  readonly source: string;
  readonly helpers?: "cad-v1";
  readonly target?: Document;
  readonly directory: string;
}
export interface Execution {
  readonly requestId: string;
  readonly state: "succeeded" | "failed" | "unknown";
  readonly sdkSettled: boolean;
  readonly mayHaveMutated: boolean;
  readonly stdout: string;
  readonly error?: string;
}
export interface ScenarioBackend {
  readonly identity: string;
  readonly mode: "fusion" | "simulator";
  readonly qualification: "broker" | "component";
  readonly protocol: Protocol;
  readonly capabilities: ReadonlySet<string>;
  fusionPath(local: string): string;
  execute(request: ScriptRequest): Promise<Execution>;
  /** Read the exact original result. This method must never submit a command. */
  lookup?(owner: Owner, requestId: string): Promise<Execution | null>;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Expected a nonempty string");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a finite number");
  return value;
}
