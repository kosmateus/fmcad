import { createRequire } from "node:module";
import type { CadContext, CatalogInvocation } from "@fmcad/core";
import type { CadClient, CadInternal } from "./cad-execution.js";

const load = createRequire(__filename);
const catalog = load("../../catalog/index.js") as {
  validateInvocation(value: unknown): CatalogInvocation;
  localInvocation(value: CatalogInvocation): boolean;
};
const invocation = load(
  "../node-adapters/execution/invocation.js",
) as typeof import("../../packages/node-adapters/src/execution/invocation.js");
const application = load(
  "../core/application/cad/worker-command.js",
) as typeof import("../../packages/core/src/application/cad/worker-command.js");

/** Entry points share this path; no argv parsing, transport framing or queue IO. */
export async function executeInvocation(
  value: unknown,
  client: CadClient | null | undefined,
  onOutcome: (value: unknown) => void = () => {},
  internal: CadInternal = {},
) {
  const input = catalog.validateInvocation(value);
  if (!catalog.localInvocation(input) && !client)
    throw new Error("Catalog invocation requires a backend");
  return invocation.context.run({ description: input.purpose }, async () => {
    const context: CadContext = {};
    for (const key of [
      "doc",
      "docId",
      "docFileId",
      "component",
      "projectId",
    ] as const) {
      const value = input[key];
      if (value !== undefined) context[key] = value;
    }
    // Preserve the original request field order: it contributes to source bytes.
    context.preview = input.preview === true;
    const cad = load(
      "./cad-execution.js",
    ) as typeof import("./cad-execution.js");
    const result = await cad.executeCad(
      client,
      input.operation,
      input.data,
      context,
      internal,
    );
    onOutcome(result);
    return result;
  });
}

export const invocationFailed = application.cadCommandFailed;
