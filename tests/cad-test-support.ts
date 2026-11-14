import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
export interface CatalogEntry {
  nodeOnly?: boolean;
  internalOnly?: boolean;
  curve?: boolean;
  dataImport?: boolean;
  readOnly: boolean;
  inputs: Record<string, unknown>;
  example: Record<string, unknown> & {
    scope?: { document?: { creationId?: string; fileId?: string } };
  };
}
export interface Command {
  kind: string;
  key: string;
  target: string;
  aliases?: string[];
  usage: string;
}
export interface ToolRequest {
  object: { script: string; readOnly: boolean };
}
export interface CadApi {
  catalog: Record<string, CatalogEntry>;
  validateCad(operation: string, data: unknown): CatalogEntry;
  buildCadScript(operation: string, data: unknown, context: unknown): string;
  prepareCadScript(
    operation: string,
    data: unknown,
    context: unknown,
  ): PreparedPythonArtifact & { request: { operation: string } };
  executeCad(
    client: unknown,
    operation: string,
    data: unknown,
    context: unknown,
  ): Promise<{ success: boolean; steps: { status: string }[] }>;
}
export interface CommandsApi {
  commands: Command[];
  findCommand(words: string[]): Command;
}
export interface CliPorts {
  loadConfig(): never;
  McpClient: new () => object;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  setExitCode(): void;
}
