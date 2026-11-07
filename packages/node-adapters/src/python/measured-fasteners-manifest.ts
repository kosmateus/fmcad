import type { BundleModule } from "./bundle.js";

/** Isolated family graph; the canonical bundle is unchanged until its slot. */
export const measuredFastenerHandlers = Object.freeze([
  "fastener.measured-check",
] as const);

export const measuredFastenerBundleManifest: readonly BundleModule[] =
  Object.freeze(
    [
      {
        id: "measured-fasteners-domain",
        path: "runtime/python/fmcad/domain/measured_fasteners.py",
        dependencies: [],
      },
      {
        id: "measured-fasteners-application",
        path: "runtime/python/fmcad/application/measured_fasteners.py",
        dependencies: ["measured-fasteners-domain"],
      },
      {
        id: "measured-fasteners-fusion",
        path: "runtime/python/fmcad/adapters/fusion/measured_fasteners.py",
        dependencies: [
          "core",
          "measure",
          "fastener",
          "sequence",
          "measured-fasteners-application",
        ],
      },
      {
        id: "measured-fasteners-handlers",
        path: "runtime/python/fmcad/application/measured_fasteners_handlers.py",
        dependencies: ["measured-fasteners-fusion"],
        owner: "measured-fasteners",
      },
    ].map((item) =>
      Object.freeze({
        ...item,
        dependencies: Object.freeze(item.dependencies),
      }),
    ),
  );

/** Add measured fasteners once, after its legacy calculation and tool helpers. */
export function withMeasuredFasteners(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (
    manifest.some((item) =>
      measuredFastenerBundleManifest.some(
        (module) => module.id === item.id || module.path === item.path,
      ),
    )
  )
    throw new Error("Measured-fastener modules are already present");
  return Object.freeze([...manifest, ...measuredFastenerBundleManifest]);
}
