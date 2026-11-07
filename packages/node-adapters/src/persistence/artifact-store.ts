import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  ArtifactId,
  RequestContext,
} from "../../../core/src/domain/contracts.js";
import type { ArtifactStore } from "../../../core/src/ports/index.js";
import { durable, failure, readBytes } from "./records.js";
import { projectDirectory, regularDirectory } from "./owned-results.js";

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function requestOwner(context: RequestContext): {
  projectId: string;
  documentId: string;
} {
  if (
    context.version !== 1 ||
    typeof context.projectId !== "string" ||
    !context.projectId ||
    typeof context.documentId !== "string" ||
    !context.documentId
  ) {
    failure(
      "INVALID_ARTIFACT",
      "Artifact storage requires an exact project and document context",
    );
  }
  return { projectId: context.projectId, documentId: context.documentId };
}

function artifactId(value: ArtifactId): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(value))
    failure("INVALID_ARTIFACT", "Invalid artifact ID");
  return value;
}

function artifactDirectory(project: string, create = false): string {
  return regularDirectory(project, [".cad", "artifacts"], create);
}

/** Durable project-scoped implementation of the shared core ArtifactStore port. */
export function createArtifactStore(cwd: string): ArtifactStore {
  if (!path.isAbsolute(cwd))
    failure("INVALID_ARTIFACT", "Artifact project directory must be absolute");
  const project = projectDirectory(cwd) ?? fs.realpathSync(cwd);

  return {
    async read(context, suppliedId) {
      const owner = requestOwner(context);
      const id = artifactId(suppliedId);
      let directory: string;
      try {
        directory = artifactDirectory(project);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const file = path.join(directory, id + ".json");
      let bytes: Buffer;
      try {
        bytes = readBytes(file, MAX_BYTES, fs, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        failure("CORRUPT_STATE", "Artifact record is not valid JSON");
      }
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        failure("CORRUPT_STATE", "Artifact record must be an object");
      const record = envelope as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !==
          "artifactId,content,documentId,mediaType,projectId,sha256,version" ||
        record["version"] !== 1 ||
        record["artifactId"] !== id ||
        record["projectId"] !== owner.projectId ||
        record["documentId"] !== owner.documentId ||
        typeof record["mediaType"] !== "string" ||
        typeof record["content"] !== "string" ||
        typeof record["sha256"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record["sha256"])
      ) {
        failure(
          "INVALID_ARTIFACT",
          "Artifact owner, identity, or record shape does not match this request",
        );
      }
      if (digest(record["content"]) !== record["sha256"])
        failure("CORRUPT_STATE", "Artifact content hash mismatch");
      return record["content"];
    },

    async write(context, content, mediaType) {
      const owner = requestOwner(context);
      if (
        typeof content !== "string" ||
        Buffer.byteLength(content, "utf8") > MAX_BYTES ||
        typeof mediaType !== "string" ||
        !mediaType.trim() ||
        mediaType.length > 256
      ) {
        failure(
          "INVALID_ARTIFACT",
          "Artifact content or media type is invalid",
        );
      }
      const id = randomUUID();
      const directory = artifactDirectory(project, true);
      const envelope = {
        version: 1,
        artifactId: id,
        projectId: owner.projectId,
        documentId: owner.documentId,
        mediaType,
        sha256: digest(content),
        content,
      };
      durable(path.join(directory, id + ".json"), envelope, true);
      return id as ArtifactId;
    },
  };
}
