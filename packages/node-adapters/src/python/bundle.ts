import { preparePythonArtifact, type SourceInput } from "./artifact.js";
import { cadBundleUnits } from "./bundle-inventory.js";
import { selectRunBundle } from "./source-selection.js";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact.js";

export * from "./bundle-inventory.js";

export function prepareCadBundle(
  root: string,
  wrapper: string,
  metadata: { readonly context?: unknown; readonly request?: unknown } = {},
  profile: "full" | "document-status" = "full",
  embedded: readonly SourceInput[] = [],
): PreparedPythonArtifact {
  return preparePythonArtifact(
    [
      ...(profile === "full"
        ? selectRunBundle(
            root,
            [...embedded.map((unit) => unit.source), wrapper].join("\n"),
            embedded.length === 0,
          )
        : cadBundleUnits(root, profile)),
      ...embedded,
      {
        id: "wrapper",
        filename: "<fmcad-wrapper>",
        source: wrapper,
        role: "wrapper",
      },
    ],
    metadata,
  );
}
