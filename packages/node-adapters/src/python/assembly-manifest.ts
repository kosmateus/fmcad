import type { BundleModule } from "./bundle.js";

/** Family-owned units, composed by the canonical bundle in legacy family order. */
export const assemblyFamilies = Object.freeze([
  "assembly",
  "definitions",
  "fastener",
  "gear",
  "mechanism",
  "pose",
  "route3d",
  "sequence",
  "sheetmetal",
  "spring",
  "thread",
] as const);

export const assemblyBundleManifest: readonly BundleModule[] = Object.freeze(
  assemblyFamilies.flatMap((family) => {
    const prerequisites =
      family === "spring" ? ["shapes"] : family === "thread" ? ["model"] : [];
    return [
      {
        id: `${family}-domain`,
        path: `runtime/python/fmcad/domain/${family}.py`,
        dependencies: [],
      },
      ...(family === "sequence"
        ? [
            {
              id: "sequence-application",
              path: "runtime/python/fmcad/application/sequence.py",
              dependencies: ["sequence-domain"],
            },
          ]
        : []),
      {
        id: `${family}-fusion`,
        path: `runtime/python/fmcad/adapters/fusion/${family}.py`,
        dependencies: [
          "core",
          `${family}-domain`,
          ...prerequisites,
          ...(family === "sequence" ? ["sequence-application"] : []),
        ],
      },
      {
        id: family,
        path: `assets/cad/${family}.py`,
        dependencies: [`${family}-fusion`],
      },
    ].map((unit) =>
      Object.freeze({
        ...unit,
        dependencies: Object.freeze(unit.dependencies),
      }),
    );
  }),
);
