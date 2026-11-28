import { createHash } from "node:crypto";
import type {
  ArtifactId,
  RequestContext,
} from "../../../core/src/domain/contracts";
import type { ArtifactStore } from "../../../core/src/ports";

const MEDIA_TYPE = "application/vnd.fmcad.selection-rule+json;version=1";
const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface SelectionRuleArtifactReference {
  readonly version: 1;
  readonly artifactId: ArtifactId;
  readonly projectId: string;
  readonly documentFileId: string;
  readonly documentCreationId: string | null;
  readonly sha256: string;
}

export type SelectionRuleManifest = Readonly<Record<string, unknown>>;

interface SelectionRuleOwner {
  readonly projectId: string;
  readonly documentFileId: string;
  readonly documentCreationId: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
  return value as Record<string, unknown>;
}

function ownerOf(value: unknown): SelectionRuleOwner {
  const owner = record(
    record(value, "Selection rule manifest")["owner"],
    "Selection rule owner",
  );
  if (
    Object.keys(owner).sort().join(",") !==
      "documentCreationId,documentFileId,projectId" ||
    typeof owner["projectId"] !== "string" ||
    !owner["projectId"] ||
    typeof owner["documentFileId"] !== "string" ||
    !owner["documentFileId"] ||
    (owner["documentCreationId"] !== null &&
      typeof owner["documentCreationId"] !== "string")
  ) {
    throw new Error("Selection rule owner is incomplete");
  }
  return {
    projectId: owner["projectId"],
    documentFileId: owner["documentFileId"],
    documentCreationId: owner["documentCreationId"],
  };
}

function assertManifest(value: unknown): SelectionRuleManifest {
  const manifest = record(value, "Selection rule manifest");
  if (manifest["schemaVersion"] !== 1)
    throw new Error("Unsupported selection rule manifest version");
  const rule = record(manifest["rule"], "Selection rule definition");
  if (
    typeof rule["id"] !== "string" ||
    !rule["id"] ||
    rule["version"] !== 1 ||
    !Number.isSafeInteger(manifest["revision"]) ||
    (manifest["revision"] as number) < 1
  ) {
    throw new Error("Selection rule manifest version or identity is invalid");
  }
  const source = record(manifest["source"], "Selection rule source");
  if (
    typeof source["documentName"] !== "string" ||
    !source["documentName"] ||
    !Number.isSafeInteger(source["version"]) ||
    (source["version"] as number) < 0
  ) {
    throw new Error("Selection rule source provenance is incomplete");
  }
  return manifest;
}

function assertContextOwner(
  context: RequestContext,
  owner: SelectionRuleOwner,
): void {
  if (
    context.projectId === null ||
    context.documentId === null ||
    context.projectId !== owner.projectId ||
    context.documentId !== owner.documentFileId
  ) {
    throw new Error(
      "Selection rule artifact belongs to a different project or document",
    );
  }
}

function sameOwner(
  left: SelectionRuleOwner,
  right: SelectionRuleOwner,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.documentFileId === right.documentFileId &&
    left.documentCreationId === right.documentCreationId
  );
}

export function validateReference(
  value: unknown,
): SelectionRuleArtifactReference {
  const reference = record(value, "Selection rule artifact reference");
  if (
    Object.keys(reference).sort().join(",") !==
      "artifactId,documentCreationId,documentFileId,projectId,sha256,version" ||
    reference["version"] !== 1 ||
    typeof reference["artifactId"] !== "string" ||
    typeof reference["projectId"] !== "string" ||
    typeof reference["documentFileId"] !== "string" ||
    (reference["documentCreationId"] !== null &&
      typeof reference["documentCreationId"] !== "string") ||
    typeof reference["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(reference["sha256"])
  ) {
    throw new Error("Invalid selection rule artifact reference");
  }
  if (
    !reference["artifactId"].trim() ||
    reference["artifactId"].length > 256 ||
    /[\x00-\x1f\x7f]/u.test(reference["artifactId"])
  ) {
    throw new Error("Invalid selection rule artifact ID");
  }
  return {
    version: 1,
    artifactId: reference["artifactId"] as ArtifactId,
    projectId: reference["projectId"],
    documentFileId: reference["documentFileId"],
    documentCreationId: reference["documentCreationId"],
    sha256: reference["sha256"],
  };
}

/** Client for immutable, request-context-owned selection manifests. */
export function createSelectionRuleArtifactClient(artifacts: ArtifactStore) {
  return {
    async write(
      context: RequestContext,
      value: SelectionRuleManifest,
    ): Promise<SelectionRuleArtifactReference> {
      const manifest = assertManifest(value);
      const owner = ownerOf(manifest);
      assertContextOwner(context, owner);
      const content = JSON.stringify({
        schemaVersion: 1,
        kind: "selection-rule",
        owner,
        manifest,
      });
      const artifactId = await artifacts.write(context, content, MEDIA_TYPE);
      return {
        version: 1,
        artifactId,
        ...owner,
        sha256: digest(content),
      };
    },

    async read(
      context: RequestContext,
      value: SelectionRuleArtifactReference,
    ): Promise<SelectionRuleManifest | null> {
      const reference = validateReference(value);
      const expectedOwner: SelectionRuleOwner = {
        projectId: reference.projectId,
        documentFileId: reference.documentFileId,
        documentCreationId: reference.documentCreationId,
      };
      assertContextOwner(context, expectedOwner);
      const content = await artifacts.read(context, reference.artifactId);
      if (content === null) return null;
      if (digest(content) !== reference.sha256)
        throw new Error("Selection rule artifact hash mismatch");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        throw new Error("Selection rule artifact is not valid JSON");
      }
      const envelope = record(parsed, "Selection rule artifact");
      if (
        Object.keys(envelope).sort().join(",") !==
          "kind,manifest,owner,schemaVersion" ||
        envelope["schemaVersion"] !== 1 ||
        envelope["kind"] !== "selection-rule"
      ) {
        throw new Error("Unsupported selection rule artifact envelope");
      }
      const manifest = assertManifest(envelope["manifest"]);
      const storedOwner = ownerOf(manifest);
      if (
        !sameOwner(ownerOf(envelope), expectedOwner) ||
        !sameOwner(storedOwner, expectedOwner)
      ) {
        throw new Error("Selection rule artifact ownership conflict");
      }
      return manifest;
    },
  };
}
