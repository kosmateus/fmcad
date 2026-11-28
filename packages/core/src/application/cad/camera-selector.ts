import type { CadContext, CameraAliasObservation } from "./contracts";

// Reserved basic references cannot refer to a persisted alias.
const origins: Readonly<Record<string, string>> = Object.freeze({
  XY: "xYConstructionPlane",
  XZ: "xZConstructionPlane",
  YZ: "yZConstructionPlane",
  X: "xConstructionAxis",
  Y: "yConstructionAxis",
  Z: "zConstructionAxis",
  origin: "originConstructionPoint",
});
export function cameraSelector(
  context: CadContext,
  alias?: CameraAliasObservation,
) {
  if (context.component == null) return { kind: "none" } as const;
  if (typeof context.component !== "string") return { kind: "direct" } as const;
  if (context.component === "root")
    return { kind: "reserved", property: null } as const;
  if (Object.hasOwn(origins, context.component))
    return { kind: "reserved", property: origins[context.component]! } as const;
  return {
    kind: !alias ? "discover" : alias.absent ? "plain" : "alias",
  } as const;
}
