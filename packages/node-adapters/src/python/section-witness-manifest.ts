import type { BundleModule } from "./bundle.js";

/** Canonical section-witness family graph and explicit handler exports. */
export const sectionWitnessHandlers = Object.freeze([
  "measure.section-series",
  "measure.witness-check",
] as const);

export const sectionWitnessBundleManifest: readonly BundleModule[] =
  Object.freeze(
    [
      {
        id: "section-witness-domain",
        path: "runtime/python/fmcad/domain/section_witness.py",
        dependencies: [],
      },
      {
        id: "section-witness-fusion",
        path: "runtime/python/fmcad/adapters/fusion/section_witness.py",
        dependencies: ["core", "measure", "section-witness-domain"],
      },
      {
        id: "section-witness-application",
        path: "runtime/python/fmcad/application/section_witness.py",
        dependencies: ["section-witness-fusion"],
      },
      {
        id: "section-witness",
        path: "runtime/python/fmcad/application/section_witness_handlers.py",
        dependencies: ["section-witness-application"],
        owner: "section-witness",
      },
    ].map((item) =>
      Object.freeze({
        ...item,
        dependencies: Object.freeze(item.dependencies),
      }),
    ),
  );

/** Insert the family immediately after the retained measure owner. */
export function withSectionWitnessModules(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (
    manifest.some((item) =>
      sectionWitnessBundleManifest.some((unit) => unit.id === item.id),
    )
  )
    throw new Error("Section witness modules are already present");
  let inserted = false;
  const result = manifest.flatMap((item) => {
    if (item.id !== "measure") return [item];
    inserted = true;
    return [item, ...sectionWitnessBundleManifest];
  });
  if (!inserted) throw new Error("Canonical bundle is missing measure owner");
  return Object.freeze(result);
}
