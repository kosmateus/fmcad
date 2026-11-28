import type { CadContext } from "@fmcad/core";
import {
  cameraSaveHandlerPlan,
  cameraSaveCanonicalSources,
  cameraSaveTypingSources,
} from "./camera-read-registry.js";
import { planCameraSaveContext } from "./camera-context-registry.js";
import { prepareCanonicalRegisteredPayload } from "./registered-payload.js";

/** Single composition boundary used by both public frontends and the broker compiler. */
export function prepareCameraSavePayload(
  root: string,
  wrapper: string,
  metadata: { readonly context?: unknown; readonly request?: unknown },
) {
  if (
    !metadata.context ||
    typeof metadata.context !== "object" ||
    !metadata.request ||
    typeof metadata.request !== "object" ||
    !("operation" in metadata.request) ||
    metadata.request.operation !== "camera.save"
  )
    throw new Error(
      "Registered camera read requires a camera.save request and context",
    );
  const target = planCameraSaveContext(metadata.context as CadContext);
  if (!target)
    throw new Error("Camera read requires a registered component resolver");
  const typing = [
    ...cameraSaveTypingSources,
    ...target.typingReferences,
  ].filter((ref) => ref.importName !== "typing.TYPE_CHECKING");
  return prepareCanonicalRegisteredPayload(
    root,
    [...cameraSaveHandlerPlan.definitions, ...target.definitions],
    [...cameraSaveCanonicalSources, ...target.references],
    ["adsk", "adsk.fusion", ...target.roots, ...cameraSaveHandlerPlan.roots],
    target.conditions,
    {
      id: "wrapper",
      filename: "<fmcad-wrapper>",
      role: "wrapper",
      source: wrapper,
    },
    metadata,
    typing,
  );
}
