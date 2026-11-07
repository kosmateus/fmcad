import * as path from "node:path";
import { createHash } from "node:crypto";
import { durable, durableBytes, failure, readBytes, readJson } from "./records";
import { regularDirectory } from "./owned-results";

export interface AcceptedBytes {
  version: 1;
  kind: "source" | "payload";
  sha256: string;
  bytes: number;
  originalPath: string | null;
}
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function retain(
  dir: string,
  bytes: Buffer,
  kind: AcceptedBytes["kind"],
  originalPath: string | null,
): AcceptedBytes {
  const sha256 = hash(bytes);
  const directory = regularDirectory(dir, ["accepted"], true);
  const file = path.join(directory, sha256);
  try {
    durableBytes(file, bytes, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hash(readBytes(file, 128 * 1024 * 1024)) !== sha256)
      failure("CORRUPT_STATE", "Accepted bytes conflict");
  }
  return { version: 1, kind, sha256, bytes: bytes.length, originalPath };
}

/** Called before admission; never reconstruct accepted bytes from a later file. */
export function captureAcceptedInputs(
  dir: string,
  request: {
    cwd?: string;
    payload?: unknown;
    inputFiles?: { path: string; sha256: string }[];
  },
): AcceptedBytes[] {
  const references: AcceptedBytes[] = [];
  if (request.payload !== undefined)
    references.push(
      retain(
        dir,
        Buffer.from(JSON.stringify(request.payload)),
        "payload",
        null,
      ),
    );
  for (const source of request.inputFiles ?? []) {
    const file = path.resolve(request.cwd ?? dir, source.path);
    const bytes = readBytes(file, 128 * 1024 * 1024);
    if (hash(bytes) !== source.sha256)
      failure(
        "INPUT_CHANGED",
        "Input differs from submitted SHA256; request not admitted",
      );
    references.push(retain(dir, bytes, "source", file));
  }
  return references;
}

export function readAcceptedInput(
  dir: string,
  reference?: AcceptedBytes,
):
  | { status: "available"; bytes: Buffer; provenance: AcceptedBytes }
  | { status: "missing" } {
  if (!reference) return { status: "missing" }; // Old records have no original-byte evidence.
  if (
    reference.version !== 1 ||
    !["source", "payload"].includes(reference.kind) ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0 ||
    reference.bytes > 128 * 1024 * 1024
  )
    failure("INVALID_ARTIFACT", "Invalid accepted-byte reference");
  try {
    const directory = regularDirectory(dir, ["accepted"]);
    const bytes = readBytes(
      path.join(directory, reference.sha256),
      128 * 1024 * 1024,
    );
    if (bytes.length !== reference.bytes || hash(bytes) !== reference.sha256)
      failure("CORRUPT_STATE", "Accepted bytes hash/size mismatch");
    return { status: "available", bytes, provenance: reference };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    throw error;
  }
}

interface AdmissionIdentity {
  clientId: string;
  requestId: string;
}
function admissionName(identity: AdmissionIdentity): string {
  if (!identity.clientId || !identity.requestId)
    failure("INVALID_REQUEST", "Admission identity required");
  return hash(
    Buffer.from(JSON.stringify([identity.clientId, identity.requestId])),
  );
}

/** Separate from the immutable queue request: old idempotency hashes stay unchanged. */
export function readAdmission(
  dir: string,
  identity: AdmissionIdentity,
):
  | { status: "available"; inputs: AcceptedBytes[]; inputIdentity: string }
  | { status: "missing" } {
  try {
    const directory = regularDirectory(dir, ["admissions"]);
    const value = readJson(path.join(directory, admissionName(identity))) as {
      version: number;
      clientId: string;
      requestId: string;
      inputs: AcceptedBytes[];
      inputIdentity: string;
    };
    if (
      !value ||
      value.version !== 1 ||
      value.clientId !== identity.clientId ||
      value.requestId !== identity.requestId ||
      !Array.isArray(value.inputs) ||
      !/^[a-f0-9]{64}$/.test(value.inputIdentity)
    ) {
      failure("CORRUPT_STATE", "Invalid admission provenance");
    }
    return {
      status: "available",
      inputs: value.inputs,
      inputIdentity: value.inputIdentity,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    throw error;
  }
}

export function retainAdmission(
  dir: string,
  request: AdmissionIdentity & Parameters<typeof captureAcceptedInputs>[1],
): void {
  // Identity describes the bytes, not mutable file metadata. Canonicalize object
  // keys so an equivalent retried JSON request reuses the exact accepted payload.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object")
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ":" +
              canonical((value as Record<string, unknown>)[key]),
          )
          .join(",") +
        "}"
      );
    return JSON.stringify(value) ?? "null";
  };
  const inputIdentity = hash(
    Buffer.from(
      canonical({
        cwd: request.cwd ?? null,
        payload: request.payload ?? null,
        inputFiles: request.inputFiles ?? [],
      }),
    ),
  );
  const previous = readAdmission(dir, request);
  if (previous.status === "available") {
    if (previous.inputIdentity !== inputIdentity)
      failure(
        "REQUEST_CONFLICT",
        "Admission provenance already binds different input bytes",
      );
    return;
  }
  const inputs = captureAcceptedInputs(dir, request);
  const directory = regularDirectory(dir, ["admissions"], true);
  durable(
    path.join(directory, admissionName(request)),
    {
      version: 1,
      clientId: request.clientId,
      requestId: request.requestId,
      inputIdentity,
      inputs,
    },
    true,
  );
}
