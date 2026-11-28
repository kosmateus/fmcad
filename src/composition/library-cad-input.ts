import fs from "node:fs";
import { createRequire } from "node:module";
import {
  planCadInput,
  decodeCadInput,
  type CadInputFormatting,
} from "../../packages/core/src/application/cad/input";
const runtimeRequire = createRequire(__filename);
/** Decode exactly the bytes observed by the public admission boundary. */
export function parseCadInput(
  args: readonly string[],
  inputs: Readonly<Record<string, unknown>> = {},
  formatting: CadInputFormatting = {},
  readFile: (file: string) => Uint8Array = fs.readFileSync,
): ReturnType<typeof decodeCadInput> {
  const plan = planCadInput(args, inputs, formatting);
  let fileText: string | undefined;
  if (plan.payload?.kind === "file") {
    const bytes = readFile(plan.payload.value);
    if (process.env["FMCAD_QUEUE_WORKER_JOB"]) {
      const { verifyInputBytes } = runtimeRequire("../../queue-client") as Pick<
        typeof import("../queue-client"),
        "verifyInputBytes"
      >;
      verifyInputBytes(
        plan.payload.value,
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      );
    }
    fileText = Buffer.from(bytes).toString("utf8");
  }
  return decodeCadInput(plan, fileText);
}
