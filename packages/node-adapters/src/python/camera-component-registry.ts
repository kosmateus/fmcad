const core = "assets/cad/core.py";
const values = "runtime/python/fmcad/domain/values.py";
const typing = "runtime/python/fmcad/adapters/fusion/typing.py";
const camera = "runtime/python/fmcad/adapters/fusion/camera_component.py";

const sources = [
  [
    camera,
    "_camera_check_resumed_name",
    "_camera_scope_attribute",
    "_camera_matching_names",
    "_camera_add_root_match",
    "_camera_require_component",
    "_cad_unique",
  ],
  [
    camera,
    "_camera_resume_component_name",
    "_camera_component_candidates",
    "_camera_add_alias_match",
    "_camera_select_component",
  ],
  [
    camera,
    "_camera_try_component_name",
    "_camera_component_candidates",
    "_camera_select_component",
  ],
  [
    camera,
    "_camera_component_candidates",
    "_CAD_ORIGINS",
    "_cad_cast",
    "_camera_matching_names",
    "_camera_scope_attribute",
  ],
  [camera, "_camera_matching_names", "_cad_cast"],
  [camera, "_camera_scope_attribute", "_cad_cast", "_CAD_ALIAS_GROUP"],
  [camera, "_camera_require_component", "_cad_type"],
  [
    camera,
    "_camera_select_component",
    "_cad_unique",
    "_camera_apply_component",
  ],
  [camera, "_camera_apply_component", "_cad_kind", "_cad_cast"],
  [camera, "_camera_add_alias_match", "_camera_add_root_match"],
  [camera, "_camera_add_root_match", "_cad_owner", "_cad_kind"],
  [core, "_cad_owner", "_cad_cast", "_cad_kind"],
  [core, "_cad_kind", "_cad_type", "_CAD_KINDS"],
  [core, "_cad_items"],
  [core, "_cad_type"],
  [core, "_cad_unique"],
  [core, "_CAD_KINDS"],
  [core, "_CAD_ALIAS_GROUP"],
  [core, "_CAD_ORIGINS"],
] as const;

/**
 * Select in a freshly constructed, document-pinned root context. A non-null
 * return from _camera_try_component_name is the raw attribute, not success.
 * The resumed variant reruns candidate enumeration, checks that same raw value
 * before resolving, adds the eligible target, and applies the uniqueness check.
 * Neither variant dispatches the public camera read until selection succeeds.
 */
export function cameraComponentNamePlan(stage: "initial" | "resume-alias") {
  return {
    roots: [
      stage === "initial"
        ? "_camera_try_component_name"
        : "_camera_resume_component_name",
    ],
    conditions: {},
    definitions: sources.map(([, symbol, ...dependencies]) => ({
      symbol,
      sourceId: `camera.component.${symbol}`,
      dependencies: dependencies.map((dependency) => ({ symbol: dependency })),
    })),
    references: sources.map(([filename, symbol]) => ({
      id: `camera.component.${symbol}`,
      filename,
      symbol,
    })),
    typingReferences: [
      { filename: values, symbol: "_Protocol", importName: "typing.Protocol" },
      { filename: values, symbol: "_CadItemCo" },
      { filename: values, symbol: "_CadItemCollection" },
      { filename: typing, symbol: "_CadAttributes", guard: "_TYPE_CHECKING" },
      ...(stage === "initial"
        ? []
        : [
            {
              filename: values,
              symbol: "Callable",
              importName: "collections.abc.Callable",
            },
            {
              filename: core,
              symbol: "_CadTypeAlias",
              importName: "typing.TypeAlias",
            },
            { filename: core, symbol: "CadEntity", guard: "TYPE_CHECKING" },
          ]),
    ].map((reference) => ({
      ...reference,
      id: `camera.component.type.${reference.symbol}`,
    })),
  };
}
