import type { BundleModule } from "./bundle.js";

/** Canonical semantic model/frame observation units. */
export const semanticModelStateModules: readonly BundleModule[] = Object.freeze(
  [
    {
      id: "semantic-model-state-domain",
      path: "runtime/python/fmcad/domain/semantic_model_state.py",
      dependencies: [],
    },
    {
      id: "semantic-model-state-fusion",
      path: "runtime/python/fmcad/adapters/fusion/semantic_model_state.py",
      dependencies: ["core", "semantic-model-state-domain"],
    },
    {
      id: "semantic-model-state-application",
      path: "runtime/python/fmcad/application/semantic_model_state.py",
      dependencies: ["semantic-model-state-fusion"],
      owner: "semantic-model-state",
    },
  ].map((unit) =>
    Object.freeze({ ...unit, dependencies: Object.freeze(unit.dependencies) }),
  ),
);

/** Insert beside the canonical entity context used by frame observations. */
export function withSemanticModelState(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (
    manifest.some((item) =>
      semanticModelStateModules.some(
        (module) => module.id === item.id || module.path === item.path,
      ),
    )
  )
    throw new Error("Semantic model state modules are already present");
  let inserted = false;
  const result = manifest.flatMap((item) => {
    if (item.id !== "entity") return [item];
    inserted = true;
    return [item, ...semanticModelStateModules];
  });
  if (!inserted) throw new Error("Canonical bundle is missing entity owner");
  return Object.freeze(result);
}

export const semanticModelStateBundleManifest = semanticModelStateModules;
