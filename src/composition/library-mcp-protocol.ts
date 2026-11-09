import type { OwnedResultReference } from "../../packages/core/src/ports/execution-store";

export type JsonRpcId = string | number | null;
export type JsonObject = Record<string, unknown>;

export type OwnedMcpArtifactReference = OwnedResultReference;

export interface JsonRpcRequest extends JsonObject {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcMessage extends JsonObject {
  jsonrpc: "2.0";
  id?: JsonRpcId;
}

export interface McpResponse {
  status: number;
  raw: string;
  sessionId?: string;
  queueReceipt?: unknown;
  queueTools?: boolean;
  artifactOwner?: { jobId: string; cwd?: string };
  /** Existing broker-owned rpc-result.json, when the queue already externalized it. */
  ownedArtifact?: OwnedMcpArtifactReference;
}
