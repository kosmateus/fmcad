import type { BundleModule } from "./bundle.js";

// Applied once by the canonical manifest, preserving assembly-owned units.
// Asset entries remain inventory-checked compatibility facades, not handlers.
export const geometryFamilies = Object.freeze([
  "model",
  "sketch",
  "sketch_plan",
  "curve",
  "datum",
  "surface",
  "shapes",
  "feature",
] as const);

export function withGeometryModules(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  const families = new Set<string>(geometryFamilies);
  return manifest.flatMap((item): readonly BundleModule[] => {
    if (!families.has(item.id)) return [item];
    if (item.path !== `assets/cad/${item.id}.py`)
      throw new Error("Unexpected geometry family source: " + item.id);
    const domain = `geometry-${item.id}-domain`;
    const adapter = `geometry-${item.id}-fusion`;
    const application = `geometry-${item.id}-application`;
    return [
      {
        id: domain,
        path: `runtime/python/fmcad/domain/geometry_${item.id}.py`,
        dependencies: [],
      },
      {
        id: adapter,
        path: `runtime/python/fmcad/adapters/fusion/geometry_${item.id}.py`,
        dependencies: [...item.dependencies, domain],
      },
      {
        id: application,
        path: `runtime/python/fmcad/application/geometry_${item.id}.py`,
        dependencies: [adapter],
      },
      { ...item, dependencies: [...item.dependencies, application] },
    ];
  });
}
