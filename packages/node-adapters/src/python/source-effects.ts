import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sourceEffectsDriver } from "./source-effects-driver.js";

export type PythonSourceEffectProof =
  | {
      readonly status: "proven";
      readonly engineVersion: string;
      readonly sourceSha256: string;
      readonly effect: "stdout-and-readonly-metadata";
    }
  | {
      readonly status: "unproven";
      readonly engineVersion: string;
      readonly sourceSha256: string;
      readonly reasons: readonly string[];
    };

/**
 * Prove effects of module initialization followed by run(opaqueContext), if run
 * is defined. Requires the declared trusted Python/SDK primitive semantics; it
 * does not authenticate an execution environment, prove termination, inspect
 * external imports, or authorize an SDK request. Unknown constructs fail closed.
 * Source text is passed as data to an isolated AST parser, never executed.
 */
export function provePythonSourceEffects(
  source: string,
): PythonSourceEffectProof {
  const pins = {
    engineVersion: "python-source-effects-v2",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  };
  const unproven = (reason: string): PythonSourceEffectProof =>
    Object.freeze({
      ...pins,
      status: "unproven",
      reasons: Object.freeze([reason]),
    });
  if (Buffer.byteLength(source, "utf8") > 512 * 1024)
    return unproven("Source byte budget exceeded");
  const result = spawnSync(
    "python3",
    ["-I", "-S", "-B", "-c", sourceEffectsDriver],
    {
      input: JSON.stringify({ source }),
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env["PATH"] ?? "" },
    },
  );
  if (result.error || result.status !== 0)
    return unproven("Isolated AST analysis did not complete");
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (
      !data ||
      typeof data !== "object" ||
      !("proven" in data) ||
      !("reasons" in data)
    )
      return unproven("Malformed AST analysis result");
    if (
      data.proven === true &&
      Array.isArray(data.reasons) &&
      data.reasons.length === 0
    )
      return Object.freeze({
        ...pins,
        status: "proven",
        effect: "stdout-and-readonly-metadata",
      });
    if (
      data.proven === false &&
      Array.isArray(data.reasons) &&
      data.reasons.every((reason: unknown) => typeof reason === "string")
    )
      return Object.freeze({
        ...pins,
        status: "unproven",
        reasons: Object.freeze(data.reasons as string[]),
      });
  } catch {
    /* Never fall back to executing or trusting caller metadata. */
  }
  return unproven("Malformed AST analysis result");
}
