import { createHash } from "node:crypto";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact.js";
import { preparePythonArtifact, verifyPythonArtifact } from "./artifact.js";
import { trustedMetadataResource } from "./trusted-metadata-resource.js";

export interface MetadataInvocationBinding {
  readonly requestId: string;
  readonly requestSha256: string;
  readonly sourceSha256: string;
  readonly nativeSessionId: string;
  readonly hostGeneration: string;
}

/** Trusted provenance is supplied by ROOT/native receipt, not this shape. */
export interface MetadataReceiptBinding extends MetadataInvocationBinding {
  readonly resourceHash: string;
  /** FINAL combined invocation wire, not the standalone collector program. */
  readonly wireHash: string;
}

export interface ReadonlyMetadataDocument {
  readonly creationId: string;
  readonly name: string;
  readonly isSaved: boolean;
  readonly isModified: boolean;
  readonly dataFile: { readonly id: string } | null;
}

export interface ReadonlyMetadataSnapshotV1 {
  readonly schema: "readonly-metadata-snapshot-v1";
  readonly binding: MetadataReceiptBinding;
  readonly documents: readonly ReadonlyMetadataDocument[];
  readonly activeDocument: ReadonlyMetadataDocument | null;
}

export interface PreparedTrustedMetadataSnapshot {
  readonly binding: MetadataInvocationBinding;
  readonly resourceHash: string;
  readonly programHash: string;
  readonly script: string;
  readonly artifact: PreparedPythonArtifact;
}

const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, identity = false): value is string =>
  typeof value === "string" && value.length <= 8192 && (!identity || !!value);
const bindingKeys = [
  "requestId",
  "requestSha256",
  "sourceSha256",
  "nativeSessionId",
  "hostGeneration",
] as const;
const receiptKeys = [...bindingKeys, "resourceHash", "wireHash"] as const;

/** Refuse accessors and exotic objects without invoking their getters. */
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return null;
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function invocation(value: unknown): MetadataInvocationBinding | null {
  const data = record(value, bindingKeys);
  if (
    !data ||
    !text(data["requestId"], true) ||
    !digest(data["requestSha256"]) ||
    !digest(data["sourceSha256"]) ||
    !text(data["nativeSessionId"], true) ||
    !text(data["hostGeneration"], true)
  )
    return null;
  return Object.freeze({
    requestId: data["requestId"],
    requestSha256: data["requestSha256"],
    sourceSha256: data["sourceSha256"],
    nativeSessionId: data["nativeSessionId"],
    hostGeneration: data["hostGeneration"],
  });
}

function receipt(value: unknown): MetadataReceiptBinding | null {
  const data = record(value, receiptKeys);
  if (!data || !digest(data["resourceHash"]) || !digest(data["wireHash"]))
    return null;
  const base = invocation(
    Object.fromEntries(bindingKeys.map((key) => [key, data[key]])),
  );
  return base
    ? Object.freeze({
        ...base,
        resourceHash: data["resourceHash"],
        wireHash: data["wireHash"],
      })
    : null;
}

/** No SDK grant: returns a compiler-owned resource to ROOT's qualified path. */
export function prepareTrustedMetadataSnapshot(
  binding: MetadataInvocationBinding,
): PreparedTrustedMetadataSnapshot {
  const pinned = invocation(binding);
  if (!pinned) throw new TypeError("Invalid metadata invocation binding");
  const resourceHash = hash(trustedMetadataResource);
  const expected = { ...pinned, resourceHash };
  const invocationSource = `_fmcad_metadata_snapshot = _fmcad_metadata_current(${JSON.stringify(expected)})\n`;
  const artifact = preparePythonArtifact(
    [
      {
        id: "trusted-metadata-reader",
        filename: "<trusted-metadata-reader>",
        source: trustedMetadataResource,
        role: "runtime",
      },
      {
        id: "trusted-metadata-invocation",
        filename: "<trusted-metadata-invocation>",
        source: invocationSource,
        role: "wrapper",
      },
    ],
    {
      context: { profile: "readonly-metadata-snapshot-v1", binding: expected },
    },
  );
  return Object.freeze({
    binding: pinned,
    resourceHash,
    programHash: artifact.sha256,
    script: artifact.script,
    artifact,
  });
}

function document(value: unknown): ReadonlyMetadataDocument | null {
  const row = record(value, [
    "creationId",
    "name",
    "isSaved",
    "isModified",
    "dataFile",
  ]);
  if (
    !row ||
    !text(row["creationId"], true) ||
    !text(row["name"]) ||
    typeof row["isSaved"] !== "boolean" ||
    typeof row["isModified"] !== "boolean"
  )
    return null;
  let dataFile: { readonly id: string } | null = null;
  if (row["dataFile"] !== null) {
    const file = record(row["dataFile"], ["id"]);
    if (!file || !text(file["id"], true) || row["isSaved"] !== true)
      return null;
    dataFile = Object.freeze({ id: file["id"] });
  }
  return Object.freeze({
    creationId: row["creationId"],
    name: row["name"],
    isSaved: row["isSaved"],
    isModified: row["isModified"],
    dataFile,
  });
}

/**
 * DATA validation only, not a capability constructor. `current` must come from
 * ROOT's current native receipt/private registry, never caller JSON. Matching
 * hashes cannot prove that this reader ran. No handles survive into the result.
 */
export function validateReadonlyMetadataSnapshot(
  prepared: PreparedTrustedMetadataSnapshot,
  current: MetadataReceiptBinding,
  value: unknown,
): ReadonlyMetadataSnapshotV1 | null {
  try {
    verifyPythonArtifact(prepared.artifact);
    const authentic = prepareTrustedMetadataSnapshot(prepared.binding);
    if (
      prepared.script !== authentic.script ||
      prepared.programHash !== authentic.programHash ||
      prepared.resourceHash !== authentic.resourceHash ||
      prepared.artifact.artifactHash !== authentic.artifact.artifactHash
    )
      return null;
    const expected = receipt(current);
    if (
      !expected ||
      expected.resourceHash !== prepared.resourceHash ||
      bindingKeys.some((key) => expected[key] !== prepared.binding[key])
    )
      return null;
    const output = record(value, [
      "schema",
      "binding",
      "documents",
      "activeDocument",
    ]);
    if (!output || output["schema"] !== "readonly-metadata-snapshot-v1")
      return null;
    const observed = receipt(output["binding"]);
    if (!observed || receiptKeys.some((key) => observed[key] !== expected[key]))
      return null;
    const items: unknown = output["documents"];
    if (
      !Array.isArray(items) ||
      Object.getPrototypeOf(items) !== Array.prototype ||
      items.length > 1024
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(items);
    if (Reflect.ownKeys(descriptors).length !== items.length + 1) return null;
    const documents: ReadonlyMetadataDocument[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < items.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return null;
      const row = document(descriptor.value as unknown);
      if (!row || ids.has(row.creationId)) return null;
      ids.add(row.creationId);
      documents.push(row);
    }
    const activeDocument =
      output["activeDocument"] === null
        ? null
        : document(output["activeDocument"]);
    if (output["activeDocument"] !== null && activeDocument === null)
      return null;
    return Object.freeze({
      schema: "readonly-metadata-snapshot-v1",
      binding: observed,
      documents: Object.freeze(documents),
      activeDocument,
    });
  } catch {
    return null;
  }
}
