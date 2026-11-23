import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact.js";
import { prepareWireArtifact } from "./source-units.js";
import { resolveRuntimePaths } from "../config-platform/runtime-paths.js";
import { provePythonSourceEffects } from "./source-effects.js";
import { isolatedStdoutInventory } from "./isolated-stdout-inventory.js";
import {
  emitIsolatedStdoutKernel,
  isolatedStdoutPrimitives,
} from "./isolated-stdout-kernel.js";

export type IsolatedStdoutPreparation =
  | {
      readonly status: "prepared";
      readonly sourceSha256: string;
      readonly programHash: string;
      readonly script: string;
      readonly artifact: PreparedPythonArtifact;
      readonly engineVersion: "python-source-effects-v2";
      readonly profileVersion: "isolated-stdout-v1";
    }
  | {
      readonly status: "unsupported";
      readonly sourceSha256: string;
      readonly reasons: readonly string[];
      readonly engineVersion: "python-source-effects-v2";
      readonly profileVersion: "isolated-stdout-v1";
    };

/** A bounded execution profile, not an SDK permission or proof of trusted host entry. */
export function prepareIsolatedStdout(
  source: string,
): IsolatedStdoutPreparation {
  const pins = {
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    engineVersion: "python-source-effects-v2" as const,
    profileVersion: "isolated-stdout-v1" as const,
  };
  const unsupported = (reasons: readonly string[]): IsolatedStdoutPreparation =>
    Object.freeze({
      ...pins,
      status: "unsupported",
      reasons: Object.freeze([...reasons]),
    });
  const proof = provePythonSourceEffects(source);
  if (proof.status !== "proven") return unsupported(proof.reasons);
  if (
    proof.engineVersion !== pins.engineVersion ||
    proof.sourceSha256 !== pins.sourceSha256
  )
    return unsupported(["Source analysis engine or source binding differs"]);
  const inventory = spawnSync(
    "python3",
    ["-I", "-S", "-B", "-c", isolatedStdoutInventory],
    {
      input: JSON.stringify({ source }),
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 256 * 1024,
      env: { PATH: process.env["PATH"] ?? "" },
    },
  );
  if (inventory.error || inventory.status !== 0)
    return unsupported(["AST inventory unavailable"]);
  try {
    const result: unknown = JSON.parse(inventory.stdout);
    if (
      !result ||
      typeof result !== "object" ||
      !("imports" in result) ||
      !("fileArgument" in result) ||
      !("names" in result) ||
      result.imports !== false ||
      result.fileArgument !== false ||
      !Array.isArray(result.names) ||
      !result.names.every((name: unknown) => typeof name === "string")
    )
      return unsupported([
        "Imports, file arguments or unsupported AST inventory",
      ]);
    if (result.names.includes("_mcp_result"))
      return unsupported([
        "Return-value carrier semantics are outside stdout-only profile",
      ]);
    const names = result.names.filter((name: string) =>
      Object.hasOwn(isolatedStdoutPrimitives, name),
    );
    const script = emitIsolatedStdoutKernel(source, names);
    const artifact = prepareWireArtifact(
      resolveRuntimePaths({ anchor: __filename }).runtime,
      script,
      {
        context: {
          profileVersion: pins.profileVersion,
          engineVersion: pins.engineVersion,
          sourceSha256: pins.sourceSha256,
          entrypoints: ["<fmcad-wire>"],
        },
      },
    );
    const embedded = artifact.units.filter((unit) => unit.role === "user");
    if (
      artifact.script !== script ||
      embedded.length !== 1 ||
      embedded[0]?.source !== source ||
      embedded[0]?.sha256 !== pins.sourceSha256
    )
      return unsupported([
        "Actual wire extraction does not match the exact original source",
      ]);
    return Object.freeze({
      ...pins,
      status: "prepared",
      script,
      artifact,
      programHash: artifact.sha256,
    });
  } catch {
    return unsupported(["AST inventory or actual wire preparation unavailable"]);
  }
}
