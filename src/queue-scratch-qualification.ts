import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SourceInput } from "../packages/node-adapters/src/python/artifact";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
const load = createRequire(__filename);
const { preparePythonArtifact } = load(
  "./python",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { hash, fusionPath } = load("./queue-instance") as {
  hash(value: string): string;
  fusionPath(file: string): string;
};
const { hash: canonicalHash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "SCRATCH_QUALIFICATION_INVALID",
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return record(value) ? value : {};
}
export interface ScratchBinding extends Record<string, unknown> {
  purpose: string;
  epochId: string;
  sdkProofPath: string;
  document?: { creationId: string; name: string; fileId: string | null };
  forbiddenIds?: string[];
  captureActiveDocument?: boolean;
  restoreActiveCreationId?: string | null;
}
// Keep the predecessor's byte spelling, including Unicode, for receipt provenance.
function literal(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return "[" + value.map(literal).join(", ") + "]";
  if (record(value))
    return (
      "{" +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + ": " + literal(v))
        .join(", ") +
      "}"
    );
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    fail("Scratch source requires JSON-serializable identity");
  return serialized;
}
export function prepareScratchQualification(
  installation: string,
  _identity: unknown,
  binding: ScratchBinding,
  { directory }: { directory: string },
): {
  artifact: PreparedPythonArtifact;
  sourceFile: string;
  sourceSha256: string;
  proofPath: string;
} {
  const closing = binding.purpose === "isolated-scratch-close-v1";
  const inputs: SourceInput[] = [
    "runtime/python/recovery/atomic_audit.py",
    "runtime/python/recovery/scratch_epoch.py",
  ].map((filename, i) => ({
    id: i ? "fresh-scratch" : "audit-types",
    filename,
    role: "runtime",
    source: fs.readFileSync(path.join(installation, filename), "utf8"),
  }));
  const proofPath = path.join(
    directory,
    closing ? "sdk-closed.json" : "sdk-qualified.json",
  );
  if (binding.sdkProofPath !== proofPath)
    fail("Scratch proof escaped its broker-derived directory");
  const args = {
    epochId: binding.epochId,
    name: "FMCAD_ISOLATED_" + binding.epochId,
    proofPath: fusionPath(proofPath),
    bindingHash: canonicalHash(binding),
    ...(closing
      ? {
          document: binding.document,
          ...(Object.hasOwn(binding, "restoreActiveCreationId")
            ? { restoreActiveCreationId: binding.restoreActiveCreationId }
            : {}),
        }
      : {
          forbiddenIds: binding.forbiddenIds,
          ...(binding.captureActiveDocument === true
            ? { captureActiveDocument: true }
            : {}),
        }),
  };
  inputs.push({
    id: "wrapper",
    filename: "<fmcad-fresh-scratch>",
    role: "wrapper",
    source: `
_EP_REQUEST: AaObject = ${literal(args)}
def run(_context: str) -> None:
    import adsk.core
    result = ${closing ? "close_qualified_scratch" : "qualify_new_scratch"}(_aa_cast(EpochApplication, adsk.core.Application.get()), _EP_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(result, allow_nan=False))
`,
  });
  const artifact = preparePythonArtifact(inputs, {
    request: args,
    context: { kind: binding.purpose, ...binding },
  });
  return {
    artifact,
    sourceFile: path.join(installation, inputs[1]!.filename),
    sourceSha256: hash(inputs[1]!.source),
    proofPath,
  };
}

function resultValue(reply: unknown): Record<string, unknown> {
  const content = object(object(reply)["result"])["content"];
  let text: unknown = Array.isArray(content)
    ? content.find((row: unknown) => object(row)["type"] === "text")
    : undefined;
  text = object(text)["text"];
  if (typeof text !== "string" || Buffer.byteLength(text) > 32768)
    fail("No bounded scratch result");
  try {
    const wrapped: unknown = JSON.parse(text);
    if (typeof object(wrapped)["stdout"] === "string")
      text = object(wrapped)["stdout"];
  } catch {
    /* Plain line. */
  }
  if (typeof text !== "string") fail("No bounded scratch result");
  try {
    const line = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("FMCAD_RESULT "));
    if (!line) fail("Malformed scratch qualification");
    const result: unknown = JSON.parse(line.slice(13));
    if (!record(result)) fail("Malformed scratch qualification");
    return result;
  } catch {
    fail("Malformed scratch qualification");
  }
}

export function parseScratchQualification(
  reply: unknown,
  _identity: unknown,
  binding: ScratchBinding,
) {
  const result = resultValue(reply);
  const document = object(result["document"]);
  const keys = [
    "version",
    "purpose",
    "epochId",
    "bindingHash",
    "document",
    "independent",
    "empty",
    "unsaved",
    "activeCommand",
    "beforeIdsHash",
    "historicalOutcome",
    "originalModelValidation",
    "originalRollbackVerification",
    ...(binding.captureActiveDocument === true
      ? ["previousActiveCreationId"]
      : []),
  ];
  if (
    !result ||
    Object.keys(result).sort().join(",") !== keys.sort().join(",") ||
    result["version"] !== 1 ||
    result["purpose"] !== "isolated-scratch-epoch-v1" ||
    result["epochId"] !== binding.epochId ||
    result["bindingHash"] !== canonicalHash(binding) ||
    !result["document"] ||
    Object.keys(document).sort().join(",") !== "creationId,fileId,name" ||
    document["name"] !== "FMCAD_ISOLATED_" + binding.epochId ||
    document["fileId"] !== null ||
    typeof document["creationId"] !== "string" ||
    !document["creationId"] ||
    binding.forbiddenIds?.includes(document["creationId"]) ||
    result["independent"] !== true ||
    result["empty"] !== true ||
    result["unsaved"] !== true ||
    (result["activeCommand"] !== "" &&
      result["activeCommand"] !== "SelectCommand") ||
    typeof result["beforeIdsHash"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(result["beforeIdsHash"]) ||
    result["historicalOutcome"] !== "unknown" ||
    result["originalModelValidation"] !== "not_performed" ||
    result["originalRollbackVerification"] !== "not_performed"
  )
    fail("Scratch identity/independence/empty/unsaved proof is incomplete");
  if (
    binding.captureActiveDocument === true &&
    result["previousActiveCreationId"] !== null &&
    (typeof result["previousActiveCreationId"] !== "string" ||
      !result["previousActiveCreationId"] ||
      result["previousActiveCreationId"] === document["creationId"])
  )
    fail("Invalid pre-scratch active document identity");
  return result;
}

export function parseScratchClose(
  reply: unknown,
  _identity: unknown,
  binding: ScratchBinding,
) {
  const result = resultValue(reply);
  const keys = [
    "version",
    "purpose",
    "document",
    "bindingHash",
    "closed",
    "saved",
    "historicalOutcome",
    "originalModelValidation",
    "originalRollbackVerification",
    ...(Object.hasOwn(binding, "restoreActiveCreationId")
      ? [
          "activeBeforeCloseCreationId",
          "restoredActiveCreationId",
          "activeDocumentRestored",
        ]
      : []),
  ];
  if (
    !result ||
    Object.keys(result).sort().join(",") !== keys.sort().join(",") ||
    result["version"] !== 1 ||
    result["purpose"] !== "isolated-scratch-close-v1" ||
    result["bindingHash"] !== canonicalHash(binding) ||
    canonicalHash(result["document"]) !== canonicalHash(binding.document) ||
    result["closed"] !== true ||
    result["saved"] !== false ||
    result["historicalOutcome"] !== "unknown" ||
    result["originalModelValidation"] !== "not_performed" ||
    result["originalRollbackVerification"] !== "not_performed"
  )
    fail("Exact qualified scratch-only close proof required");
  if (Object.hasOwn(binding, "restoreActiveCreationId")) {
    const before = result["activeBeforeCloseCreationId"];
    const target =
      before === binding.document?.creationId
        ? binding.restoreActiveCreationId
        : before;
    if (
      (before !== null && (typeof before !== "string" || !before)) ||
      result["activeDocumentRestored"] !== true ||
      result["restoredActiveCreationId"] !== target
    )
      fail(
        "Active-document restoration proof does not match the captured or user-selected identity",
      );
  }
  return result;
}
