import * as fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  units,
  type EngineeringRuntime,
} from "../../packages/core/src/domain/engineering/common";
const load = createRequire(__filename);
const { checkPublishTarget, publishComplete } = load(
  "../node-adapters/persistence/publish.js",
) as typeof import("../../packages/node-adapters/src/persistence/publish.js");

interface EngineeringResult {
  status: string;
  provenance: { inputPath?: string | null };
}
export interface EngineeringMethod {
  fields: string;
  run(data: unknown, runtime: EngineeringRuntime): EngineeringResult;
}
export interface EngineeringCommandDependencies {
  stdout: { write(value: string): unknown };
  engineeringRuntime?: EngineeringRuntime;
}
export interface EngineeringCommandFiles {
  resolve(value: string): string;
  stat(value: string): Promise<{ size: number }>;
  readText(value: string): Promise<string>;
  checkPublishTarget(value: string): Promise<void>;
  publishComplete(value: string, contents: string): Promise<void>;
}
const nodeFiles: EngineeringCommandFiles = {
  resolve: (value) => path.resolve(value),
  stat: (value) => fs.stat(value),
  readText: (value) => fs.readFile(value, "utf8"),
  checkPublishTarget,
  publishComplete,
};

/** CLI-local parsing/publication; calculations never acquire a Fusion session. */
export function createEngineeringCommand(
  methods: Readonly<Record<string, EngineeringMethod>>,
  files: EngineeringCommandFiles = nodeFiles,
) {
  return async (
    key: string,
    argv: readonly string[],
    deps: EngineeringCommandDependencies,
  ): Promise<number> => {
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]!;
      if (!["--file", "--data", "--json", "--out", "--schema"].includes(flag))
        throw new Error(`Unknown local engineering option: ${flag}`);
      if (Object.hasOwn(flags, flag))
        throw new Error(`Duplicate option: ${flag}`);
      if (["--json", "--schema"].includes(flag)) flags[flag] = true;
      else {
        const value = argv[++i];
        if (!value || value.startsWith("--"))
          throw new Error(`Missing value for ${flag}`);
        flags[flag] = value;
      }
    }
    const method = methods[key];
    if (!method) throw new Error(`Unknown local engineering operation: ${key}`);
    if (flags["--schema"]) {
      if (flags["--file"] || flags["--data"] || flags["--out"])
        throw new Error("--schema cannot be combined with input/output");
      deps.stdout.write(
        JSON.stringify(
          {
            schemaVersion: 1,
            operation: key,
            common:
              "schemaVersion, identity:{model,revision}, frame, assumptions, budget?",
            fields: method.fields,
            quantities: units,
            documentation: "docs/ENGINEERING_LOCAL.md",
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const file = flags["--file"],
      inline = flags["--data"],
      out = flags["--out"];
    if (Number(!!file) + Number(!!inline) !== 1)
      throw new Error("Exactly one of --file or --data is required");
    let raw = typeof inline === "string" ? inline : "";
    let sourcePath: string | null = null;
    if (typeof file === "string") {
      sourcePath = files.resolve(file);
      if ((await files.stat(sourcePath)).size > 1024 * 1024)
        throw new Error("Input exceeds 1 MiB");
      raw = await files.readText(sourcePath);
    }
    if (Buffer.byteLength(raw) > 1024 * 1024)
      throw new Error("Input exceeds 1 MiB");
    const data: unknown = JSON.parse(raw);
    const result = method.run(
      data,
      deps.engineeringRuntime || { clock: { now: () => performance.now() } },
    );
    result.provenance.inputPath = sourcePath;
    const contents =
      JSON.stringify(result, null, flags["--json"] ? 0 : 2) + "\n";
    if (typeof out === "string") {
      const target = files.resolve(out);
      await files.checkPublishTarget(target);
      await files.publishComplete(target, contents);
    }
    deps.stdout.write(contents);
    return ["fail", "blocked", "unknown"].includes(result.status) ? 1 : 0;
  };
}
