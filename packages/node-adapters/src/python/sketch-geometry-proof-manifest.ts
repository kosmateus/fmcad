import type { BundleModule } from "./bundle.js";

/** Strictly typed sketch proof handlers, inserted after the existing sketch family. */
export const sketchGeometryProofHandlers = Object.freeze([
  "sketch.coordinate-check",
  "sketch.profile-query",
] as const);

export const sketchGeometryProofBundleManifest: readonly BundleModule[] =
  Object.freeze(
    [
      {
        id: "sketch-geometry-proof-application",
        path: "runtime/python/fmcad/application/sketch_geometry_proof.py",
        dependencies: [],
        owner: "sketch_geometry_proof",
      },
      {
        id: "sketch-geometry-proof-fusion",
        path: "runtime/python/fmcad/adapters/fusion/sketch_geometry_proof.py",
        dependencies: [
          "core",
          "geometry-curve-fusion",
          "geometry-sketch-fusion",
          "sketch-geometry-proof-application",
        ],
      },
    ].map((item) =>
      Object.freeze({
        ...item,
        dependencies: Object.freeze(item.dependencies),
      }),
    ),
  );

export function withSketchGeometryProofModules(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (
    manifest.some((item) =>
      sketchGeometryProofBundleManifest.some((unit) => unit.id === item.id),
    )
  )
    throw new Error("Sketch geometry proof modules are already present");
  let inserted = false;
  const result = manifest.flatMap((item) => {
    if (item.id !== "sketch") return [item];
    inserted = true;
    return [item, ...sketchGeometryProofBundleManifest];
  });
  if (!inserted)
    throw new Error("Canonical bundle is missing the sketch family owner");
  return Object.freeze(result);
}
