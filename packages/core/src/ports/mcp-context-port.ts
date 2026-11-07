import type { ClientId, InstanceId, SessionId } from "../domain/contracts";

export interface McpRootHint {
  readonly uri: string;
  readonly name?: string;
}

export interface McpProjectSelection {
  /** An explicit local project directory takes precedence over a single root. */
  readonly projectDirectory?: string;
  /** Client roots are hints, not credentials or proof of project ownership. */
  readonly roots?: readonly McpRootHint[];
}

export interface McpProjectResolution {
  readonly projectDirectory: string | null;
  readonly source: "explicit" | "root" | "none";
}

export interface McpClientIdentity {
  /** Persistent owner identity; credentials are held by the Node adapter. */
  readonly clientId: ClientId;
  /** Session is owner-scoped; only instanceId and presence are process-ephemeral. */
  readonly instanceId: InstanceId;
  readonly sessionId: SessionId;
}

export interface McpClientContextPort {
  readonly identity: McpClientIdentity;
  resolveProject(selection: McpProjectSelection): Promise<McpProjectResolution>;
}
