import type { BundleModule } from "./bundle.js";

const units: readonly BundleModule[] = Object.freeze(
  [
    {
      id: "measure-baseline-domain",
      path: "runtime/python/fmcad/domain/brep_baseline.py",
      dependencies: [],
    },
    {
      id: "measure-baseline-fusion",
      path: "runtime/python/fmcad/adapters/fusion/brep_baseline.py",
      dependencies: ["core", "measure", "measure-baseline-domain"],
    },
    {
      id: "measure-baseline-application",
      path: "runtime/python/fmcad/application/brep_baseline.py",
      dependencies: ["measure-baseline-domain", "measure-baseline-fusion"],
    },
  ].map((unit) =>
    Object.freeze({ ...unit, dependencies: Object.freeze(unit.dependencies) }),
  ),
);

/** Insert BRep baseline ownership after the retained measure implementation. */
export function withBrepBaselineModules(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (manifest.some((item) => units.some((unit) => unit.id === item.id)))
    throw new Error("BRep baseline modules are already composed");
  let inserted = false;
  const result = manifest.flatMap((item) => {
    if (item.id !== "measure") return [item];
    inserted = true;
    return [item, ...units];
  });
  if (!inserted) throw new Error("Canonical bundle is missing measure owner");
  return Object.freeze(result);
}

export const brepBaselineBundleManifest = units;
