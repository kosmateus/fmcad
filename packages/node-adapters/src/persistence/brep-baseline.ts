import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  BrepBaselineArtifacts,
  BrepBaselineManifest,
  BrepBaselineReference,
} from "../../../core/src/ports/brep-baseline";
import { durableBytes, failure, readBytes, syncDirectory } from "./records";
import { regularDirectory } from "./owned-results";

const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const format = "fusion-temporary-brep-smt-v1";
const sha = (value: unknown): boolean =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

function validate(manifest: BrepBaselineManifest): void {
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.scope !== "durable" ||
    !nonempty(manifest.source?.document) ||
    !nonempty(manifest.source?.version) ||
    !(typeof manifest.frame === "string"
      ? nonempty(manifest.frame)
      : manifest.frame &&
        nonempty(manifest.frame.space) &&
        (nonempty(manifest.frame.component) ||
          (typeof manifest.frame.component === "object" &&
            manifest.frame.component !== null &&
            !Array.isArray(manifest.frame.component)))) ||
    !Array.isArray(manifest.bodies) ||
    manifest.bodies.length < 1 ||
    manifest.bodies.length > 1000 ||
    new Set(manifest.bodies.map((body) => body.role)).size !==
      manifest.bodies.length ||
    manifest.bodies.some(
      (body) =>
        !nonempty(body.role) ||
        !nonempty(body.body) ||
        !nonempty(body.instance) ||
        !Array.isArray(body.pose) ||
        body.pose.length !== 16 ||
        !body.pose.every((n) => typeof n === "number" && Number.isFinite(n)),
    )
  )
    failure("INVALID_BASELINE", "Invalid exact baseline manifest");
}

/** Uses existing durable publication, containment and bounded-read primitives.
 * Manifest is the commit record, published last; failed payloads are never read
 * as a complete baseline. No cleanup of ambiguous/failed durable evidence.
 */
export function brepBaselineArtifacts(
  project: string,
  maxBytes = 128 * 1024 * 1024,
): BrepBaselineArtifacts {
  project = fs.realpathSync(project);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    failure("INVALID_LIMIT", "Baseline byte budget must be positive");
  const owner = digest(project);
  const directory = (id: string, create = false): string =>
    regularDirectory(project, [".cad", "baselines", id], create);
  return {
    publish(manifest, exactBodies) {
      validate(manifest);
      if (
        exactBodies.length !== manifest.bodies.length ||
        exactBodies.some((body) => !body.byteLength) ||
        exactBodies.reduce((total, body) => total + body.byteLength, 0) >
          maxBytes
      )
        failure("INVALID_BASELINE", "Exact payload count/byte budget mismatch");
      const id = randomUUID();
      const root = directory(id, true);
      const payloads = exactBodies.map((body, index) => {
        const name = `${index}.smt`;
        durableBytes(path.join(root, name), body, true);
        return { name, bytes: body.byteLength, sha256: digest(body) };
      });
      const bytes = Buffer.from(
        JSON.stringify({ format, owner, manifest, payloads }),
      );
      if (bytes.length > 1024 * 1024)
        failure("INVALID_BASELINE", "Baseline manifest exceeds byte limit");
      durableBytes(path.join(root, "manifest.json"), bytes, true);
      return { version: 1, scope: "durable", owner, id, sha256: digest(bytes) };
    },
    read(reference: BrepBaselineReference) {
      if (
        !reference ||
        Object.keys(reference).sort().join(",") !==
          "id,owner,scope,sha256,version" ||
        reference.version !== 1 ||
        reference.scope !== "durable" ||
        reference.owner !== owner ||
        !/^[a-zA-Z0-9_-]+$/.test(reference.id) ||
        !sha(reference.sha256)
      )
        failure("INVALID_BASELINE", "Baseline ownership/reference mismatch");
      const root = directory(reference.id);
      const file = path.join(root, "manifest.json");
      const bytes = readBytes(file, 1024 * 1024, fs, file);
      if (digest(bytes) !== reference.sha256)
        failure("INVALID_BASELINE", "Baseline manifest checksum mismatch");
      const record = JSON.parse(bytes.toString("utf8")) as {
        format: string;
        owner: string;
        manifest: BrepBaselineManifest;
        payloads: Array<{ name: string; bytes: number; sha256: string }>;
      };
      validate(record.manifest);
      if (
        record.format !== format ||
        record.owner !== owner ||
        !Array.isArray(record.payloads) ||
        record.payloads.length !== record.manifest.bodies.length
      )
        failure("INVALID_BASELINE", "Unsupported exact baseline artifact");
      let remaining = maxBytes;
      const exactBodies = record.payloads.map((payload, index) => {
        if (
          payload.name !== `${index}.smt` ||
          !Number.isSafeInteger(payload.bytes) ||
          payload.bytes < 1 ||
          payload.bytes > remaining ||
          !sha(payload.sha256)
        )
          failure("INVALID_BASELINE", "Invalid exact payload inventory/budget");
        const file = path.join(root, payload.name);
        const body = readBytes(file, payload.bytes, fs, file);
        if (body.length !== payload.bytes || digest(body) !== payload.sha256)
          failure("INVALID_BASELINE", "Exact payload checksum mismatch");
        remaining -= body.length;
        return body;
      });
      const bodyPayloads = record.payloads.map((payload, index) => ({
        role: record.manifest.bodies[index]!.role,
        bytes: payload.bytes,
        sha256: payload.sha256,
      }));
      return { manifest: record.manifest, exactBodies, bodyPayloads };
    },
  };
}

/** One-operation SDK staging under the owning project; never a second store. */
export function createBrepBaselineStage(
  project: string,
  count: number,
  toFusionPath: (path: string) => string,
  maxBytes = 128 * 1024 * 1024,
): {
  id: string;
  fusionPaths: string[];
  read(index: number): Uint8Array;
  write(index: number, bytes: Uint8Array): void;
  dispose(): void;
} {
  project = fs.realpathSync(project);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
    failure("INVALID_BASELINE", "Invalid BRep staging count");
  const root = regularDirectory(project, [".cad", "baseline-staging"], true);
  const directory = fs.mkdtempSync(path.join(root, "turn-"));
  fs.chmodSync(directory, 0o700);
  syncDirectory(root);
  const files = Array.from({ length: count }, (_, index) =>
    path.join(directory, `${index}.smt`),
  );
  let disposed = false;
  const file = (index: number): string => {
    if (disposed || !Number.isSafeInteger(index) || index < 0 || index >= count)
      failure("INVALID_BASELINE", "Invalid BRep staging index/state");
    return files[index]!;
  };
  return {
    id: path.basename(directory),
    fusionPaths: files.map(toFusionPath),
    read(index) {
      const target = file(index);
      return readBytes(target, maxBytes, fs, target);
    },
    write(index, bytes) {
      if (
        !(bytes instanceof Uint8Array) ||
        !bytes.byteLength ||
        bytes.byteLength > maxBytes
      )
        failure("INVALID_BASELINE", "Invalid BRep staging payload size");
      durableBytes(file(index), bytes, true);
    },
    dispose() {
      if (disposed) return;
      for (const target of files) {
        try {
          const stat = fs.lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink())
            failure(
              "INVALID_BASELINE",
              "Refuse to remove non-regular BRep stage output",
            );
          fs.unlinkSync(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        failure(
          "INVALID_BASELINE",
          "Refuse to remove replaced BRep staging directory",
        );
      fs.rmdirSync(directory);
      syncDirectory(root);
      disposed = true;
    },
  };
}
