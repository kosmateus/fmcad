import type { BundleModule } from "./bundle.js";

/** Add the isolated selection-rule family to a Python bundle at its composition site. */
export function withSelectionRules(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  const ids = new Set(manifest.map((unit) => unit.id));
  const paths = new Set(manifest.map((unit) => unit.path));
  const family: readonly BundleModule[] = [
    {
      id: "selection-rules-domain",
      path: "runtime/python/fmcad/domain/selection_rules.py",
      dependencies: [],
    },
    {
      id: "fusion-selection-rules",
      path: "runtime/python/fmcad/adapters/fusion/selection_rules.py",
      dependencies: ["entity", "selection-rules-domain"],
    },
    {
      id: "selection-rules-application",
      path: "runtime/python/fmcad/application/selection_rules.py",
      dependencies: ["fusion-selection-rules"],
      owner: "selection-rules",
    },
  ];
  for (const unit of family) {
    if (ids.has(unit.id) || paths.has(unit.path))
      throw new Error(
        "Selection-rule family conflicts with the supplied Python bundle",
      );
    ids.add(unit.id);
    paths.add(unit.path);
  }
  return Object.freeze([
    ...manifest,
    ...family.map((unit) =>
      Object.freeze({
        ...unit,
        dependencies: Object.freeze([...unit.dependencies]),
      }),
    ),
  ]);
}
