import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceInput } from "./artifact.js";
import type { BundleModule } from "./bundle.js";

export interface DocumentIoFamily {
  readonly family: string;
  readonly compatibility: string;
  readonly units: readonly BundleModule[];
}

// Root-independent inventory, composed by the real canonical bundle. The frozen
// JSON in tests/fixtures is a parity baseline, not a second runtime catalog.
const cadFamilies = [
  "animation",
  "animation2",
  "appearance",
  "atomic",
  "attributes",
  "cam",
  "checking",
  "containment",
  "data_import",
  "dfm",
  "document",
  "document_snapshot",
  "entity",
  "explode",
  "externalization",
  "fpc_pcb",
  "identity",
  "interference",
  "io",
  "marking",
  "measure",
  "optics",
  "presentation",
  "reference",
  "references",
  "seal",
  "simulation",
  "texture",
] as const;
const ruleFamilies = new Set<string>([
  "animation",
  "animation2",
  "appearance",
  "cam",
  "checking",
  "containment",
  "data_import",
  "dfm",
  "document",
  "explode",
  "externalization",
  "fpc_pcb",
  "interference",
  "io",
  "marking",
  "measure",
  "optics",
  "presentation",
  "references",
  "seal",
  "texture",
]);
const inventory: readonly DocumentIoFamily[] = Object.freeze(
  [
    ...cadFamilies.map((family): DocumentIoFamily => {
      const rules = `docio-${family}-rules`;
      const usecase = `docio-${family}-usecase`;
      const hasRules = ruleFamilies.has(family);
      const hasUsecase = family === "document" || family === "checking";
      return {
        family,
        compatibility: `assets/cad/${family}.py`,
        units: [
          ...(family === "io"
            ? [
                {
                  id: "capture-integrity",
                  path: "runtime/python/fmcad/domain/capture_integrity.py",
                  dependencies: [],
                },
              ]
            : []),
          ...(hasRules
            ? [
                {
                  id: rules,
                  path: `runtime/python/fmcad/domain/${family}.py`,
                  dependencies: [],
                },
              ]
            : []),
          ...(hasUsecase
            ? [
                {
                  id: usecase,
                  path: `runtime/python/fmcad/application/${family}.py`,
                  dependencies: [rules],
                },
              ]
            : []),
          {
            id: family,
            path: `runtime/python/fmcad/adapters/fusion/${family}.py`,
            dependencies: [
              "core",
              ...(family === "io" ? ["capture-integrity"] : []),
              ...(hasRules ? [rules] : []),
              ...(hasUsecase ? [usecase] : []),
            ],
          },
        ],
      };
    }),
    ...["review", "export", "inspect", "upload", "queue_document"].map(
      (family): DocumentIoFamily => ({
        family: `legacy-${family}`,
        compatibility: `assets/${family}.py`,
        units: [
          ...(family === "inspect"
            ? [
                {
                  id: "legacy-document",
                  path: "runtime/python/fmcad/adapters/fusion/legacy_document.py",
                  dependencies: [],
                },
              ]
            : []),
          ...(family === "review"
            ? [
                {
                  id: "capture-integrity",
                  path: "runtime/python/fmcad/domain/capture_integrity.py",
                  dependencies: [],
                },
                {
                  id: "docio-review-rules",
                  path: "runtime/python/fmcad/domain/review.py",
                  dependencies: [],
                },
              ]
            : []),
          {
            id: `legacy-${family}`,
            path: `runtime/python/fmcad/adapters/fusion/legacy_${family}.py`,
            dependencies:
              family === "review"
                ? ["capture-integrity", "docio-review-rules"]
                : family === "inspect"
                  ? ["legacy-document"]
                  : [],
          },
        ],
      }),
    ),
  ].map((family) =>
    Object.freeze({
      ...family,
      units: Object.freeze(
        family.units.map((unit) =>
          Object.freeze({
            ...unit,
            dependencies: Object.freeze(unit.dependencies),
          }),
        ),
      ),
    }),
  ),
);

export function documentIoFamilies(): readonly DocumentIoFamily[] {
  return inventory;
}

export function documentIoFamilyUnits(
  runtimeRoot: string,
  family: string,
): readonly SourceInput[] {
  const entry = documentIoFamilies().find((item) => item.family === family);
  if (!entry) throw new Error("Unknown document/I/O family: " + family);
  return entry.units.map((unit) => ({
    id: unit.id,
    filename: unit.path,
    source: readFileSync(
      join(runtimeRoot, unit.path.slice("runtime/python/".length)),
      "utf8",
    ),
    role: "runtime",
  }));
}

/** Replace one retained family with its rules/use cases/effect adapter, not two copies. */
export function documentIoCadManifest(
  base: readonly BundleModule[],
): readonly BundleModule[] {
  const families = documentIoFamilies();
  return base.flatMap((module) => {
    const family = families.find((item) => item.compatibility === module.path);
    if (!family) return [module];
    return family.units.map((unit) => ({
      ...unit,
      ...(unit.id === module.id
        ? {
            compatibilityPath: module.path,
            owner: module.id,
            dependencies: [
              ...new Set([...module.dependencies, ...unit.dependencies]),
            ],
          }
        : {}),
    }));
  });
}
