import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { id, type RequestContext } from "../../../core/src/domain/contracts";
import {
  executeSelectionRule,
  type SelectionContext,
  publicOperations,
} from "../../../core/src/application/modeling/selection-service";
import { createArtifactStore } from "./artifact-store";
import {
  createSelectionRuleArtifactClient,
  validateReference,
} from "./selection-rules";
import { projectDirectory } from "./owned-results";
export { publicOperations };
export interface SelectionExecutionPorts {
  projectDirectory?: string;
  stageDependencies?: { owner?: { scope?: { project?: string } } };
  executeNative(
    operation: string,
    payload: Record<string, unknown>,
    context: SelectionContext,
  ): Promise<unknown>;
}
function requestContext(
  owner: Readonly<Record<string, unknown>>,
  invocation: SelectionContext,
): RequestContext {
  const project = owner["projectId"],
    file = owner["documentFileId"];
  if (typeof project !== "string" || typeof file !== "string")
    throw new Error("Selection rule owner is incomplete");
  return {
    version: 1,
    clientId: id("client", "fmcad-selection-rules"),
    requestId: id("request", randomUUID()),
    sessionId: null,
    projectId: id("project", project),
    documentId: id("document", file),
    instanceId: id("instance", randomUUID()),
    purpose: invocation.purpose || null,
  };
}
export function createSelectionExecutor(
  authorize: (operation: string, payload: Record<string, unknown>) => void,
) {
  return function execute(
    client: unknown,
    operation: string,
    data: Record<string, unknown>,
    context: SelectionContext,
    ports: SelectionExecutionPorts,
  ): Promise<Record<string, unknown>> {
    return executeSelectionRule(Boolean(client), operation, data, context, {
      store() {
        const root = realpathSync(
          ports.projectDirectory ||
            ports.stageDependencies?.owner?.scope?.project ||
            process.cwd(),
        );
        const artifactClient = createSelectionRuleArtifactClient(
          createArtifactStore(projectDirectory(root) || root),
        );
        // One immutable request context per operation, retained across a possible artifact update.
        let storeContext: RequestContext | undefined;
        const getContext = (owner: Readonly<Record<string, unknown>>) =>
          (storeContext ??= requestContext(owner, context));
        return {
          read: (owner, reference) =>
            artifactClient.read(
              getContext(owner),
              validateReference(reference),
            ),
          write: (owner, manifest) =>
            artifactClient.write(getContext(owner), manifest),
        };
      },
      executeNative(op, payload, target) {
        authorize(op, payload);
        return ports.executeNative(op, payload, target);
      },
    });
  };
}
