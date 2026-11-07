import type { BundleModule } from "./bundle.js";

const units: readonly BundleModule[] = Object.freeze(
  [
    {
      id: "regional-geometry-domain",
      path: "runtime/python/fmcad/domain/regional_geometry.py",
      dependencies: [],
    },
    {
      id: "regional-geometry-fusion",
      path: "runtime/python/fmcad/adapters/fusion/regional_geometry.py",
      dependencies: ["core", "measure", "regional-geometry-domain"],
    },
    {
      id: "regional-geometry-application",
      path: "runtime/python/fmcad/application/regional_geometry.py",
      dependencies: ["regional-geometry-domain", "regional-geometry-fusion"],
    },
  ].map((unit) =>
    Object.freeze({ ...unit, dependencies: Object.freeze(unit.dependencies) }),
  ),
);

/** Insert regional geometry after its retained measure/comparator owner. */
export function withRegionalGeometryModules(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (manifest.some((item) => units.some((unit) => unit.id === item.id)))
    throw new Error("Regional geometry modules are already present");
  let inserted = false;
  const result = manifest.flatMap((item) => {
    if (item.id !== "measure") return [item];
    inserted = true;
    return [item, ...units];
  });
  if (!inserted) throw new Error("Canonical bundle is missing measure owner");
  return Object.freeze(result);
}

export const regionalGeometryBundleManifest = units;
