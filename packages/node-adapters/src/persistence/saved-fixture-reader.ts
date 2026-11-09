import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { preparePythonArtifact } from "../python/artifact";
import type { SourceInput } from "../python/artifact";
import { detectPlatform, toWindowsPath } from "../config-platform/platform";
import { assertSavedAuditPathBudget } from "./saved-audit-path";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
const fusionPath = (file: string): string =>
  toWindowsPath(file, detectPlatform());
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => {
  throw Object.assign(new Error(message), {
    code: "SAVED_FIXTURE_PROOF_INVALID",
  });
};
const literal = (value: unknown): string | undefined =>
  value === null
    ? "None"
    : value === true
      ? "True"
      : value === false
        ? "False"
        : Array.isArray(value)
          ? "[" + value.map(literal).join(", ") + "]"
          : typeof value === "object"
            ? "{" +
              Object.entries(value)
                .map(
                  ([key, item]: [string, unknown]) =>
                    JSON.stringify(key) + ": " + literal(item),
                )
                .join(", ") +
              "}"
            : JSON.stringify(value);
export function prepareSavedFixtureReader(
  installation: string,
  _identity: unknown,
  binding: Record<string, unknown>,
  { directory }: { directory: string },
) {
  assertSavedAuditPathBudget(directory);
  const retaining = binding["purpose"] === "saved-fixture-retain-v1";
  const probing = binding["purpose"] === "saved-fixture-destination-v1";
  if (
    !retaining &&
    !probing &&
    binding["purpose"] !== "saved-first-save-publication-v1"
  )
    fail("Unknown saved fixture administrative purpose");
  const proofPath = path.join(
    directory,
    retaining
      ? "sdk-retained.json"
      : probing
        ? "sdk-destination.json"
        : "sdk-publication.json",
  );
  if (binding["sdkProofPath"] !== proofPath)
    fail("Saved fixture proof escaped its broker directory");
  const sourceFiles = [
    "runtime/python/recovery/atomic_audit.py",
    "runtime/python/recovery/scratch_epoch.py",
    "runtime/python/recovery/saved_fixture.py",
  ];
  const inputs: SourceInput[] = sourceFiles.map((filename, index) => ({
    id: "saved-fixture-" + index,
    filename,
    role: "runtime",
    source: fs.readFileSync(path.join(installation, filename), "utf8"),
  }));
  const args = {
    epochId: binding["epochId"],
    document: binding["document"],
    proofPath: fusionPath(proofPath),
    bindingHash: canonicalHash(binding),
    ...(retaining
      ? {
          savedDocument: binding["savedDocument"],
          restoreActiveCreationId: binding["restoreActiveCreationId"] ?? null,
        }
      : {
          destination: binding["destination"],
          expectedFileId: binding["expectedFileId"] ?? null,
        }),
  };
  inputs.push({
    id: "wrapper",
    filename: "<fmcad-saved-fixture>",
    role: "wrapper",
    source: `
_SAVED_REQUEST: AaObject = ${literal(args)}
def run(_context: str) -> None:
    import adsk.core
    result = ${retaining ? "retain_saved_fixture" : probing ? "probe_saved_destination" : "observe_saved_fixture"}(_aa_cast(SavedFixtureApplication, adsk.core.Application.get()), _SAVED_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(result, allow_nan=False))
`,
  });
  return {
    artifact: preparePythonArtifact(inputs, {
      request: args,
      context: { kind: binding["purpose"], ...binding },
    }),
    sourceFile: path.join(installation, sourceFiles[2]!),
    sourceSha256: hash(inputs[2]!.source),
    proofPath,
  };
}
