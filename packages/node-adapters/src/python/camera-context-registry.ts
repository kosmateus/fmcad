/** Canonical context sources for camera.save without a component selector. */
export interface CameraContextInput {
  readonly component?: unknown;
  readonly projectId?: string | null;
}

interface ContextSource {
  readonly id: string;
  readonly filename: string;
  readonly symbol: string;
  readonly importName?: string;
  readonly guard?: string;
  readonly members?: readonly string[];
  readonly bindings?: Readonly<Record<string, Readonly<Record<string, null>>>>;
}

export interface CameraContextPlan {
  readonly roots: readonly string[];
  readonly conditions: Readonly<Record<string, boolean>>;
  readonly definitions: readonly {
    readonly symbol: string;
    readonly sourceId: string;
    readonly dependencies: readonly { readonly symbol: string }[];
  }[];
  readonly references: readonly ContextSource[];
  readonly typingReferences: readonly ContextSource[];
}

const core = "assets/cad/core.py";
const identity = "runtime/python/fmcad/adapters/fusion/identity.py";
const fusionTyping = "runtime/python/fmcad/adapters/fusion/typing.py";

/**
 * A null result means another explicit component-resolver plan is required.
 * It is not permission to use a whole-family payload or reject public inputs.
 * Shared `_cad_cast` and `adsk` definitions come from the handler registry.
 */
export function planCameraSaveContext(
  context: CameraContextInput,
): CameraContextPlan | null {
  if (context.component != null) return null;
  return {
    roots: ["CadContext"],
    conditions: {},
    definitions: [
      {
        symbol: "CadContext",
        sourceId: "camera.context.class",
        dependencies: [
          { symbol: "_cad_cast" },
          { symbol: "adsk" },
          { symbol: "adsk.fusion" },
          { symbol: "_document_target" },
          { symbol: "_document_assert_identity" },
        ],
      },
      {
        symbol: "adsk.fusion",
        sourceId: "camera.context.fusion-import",
        dependencies: [],
      },
      {
        symbol: "_document_target",
        sourceId: "camera.context.target",
        dependencies: [
          { symbol: "_document_named_top_level" },
          { symbol: "_document_unique_name" },
        ],
      },
      {
        symbol: "_document_assert_identity",
        sourceId: "camera.context.assert",
        dependencies: [
          { symbol: "_document_file_pin" },
          { symbol: "_document_check_pin" },
        ],
      },
      ...[
        "_document_named_top_level",
        "_document_unique_name",
        "_document_file_pin",
        "_document_check_pin",
      ].map((symbol) => ({
        symbol,
        sourceId: "camera.context." + symbol,
        dependencies:
          symbol === "_document_file_pin"
            ? [{ symbol: "_document_data_file" }]
            : [],
      })),
      {
        symbol: "_document_data_file",
        sourceId: "camera.context.data-file",
        dependencies: [],
      },
    ],
    references: [
      ...[
        "_document_named_top_level",
        "_document_unique_name",
        "_document_file_pin",
        "_document_check_pin",
      ].map((symbol) => ({
        symbol,
        id: "camera.context." + symbol,
        filename: identity,
      })),
      {
        id: "camera.context.class",
        filename: core,
        symbol: "CadContext",
        members: ["__init__", "assert_identity"],
        bindings: {
          __init__: {
            component_ref: null,
            resolved_doc: null,
            ...(context.projectId == null ? { project_id: null } : {}),
          },
        },
      },
      {
        id: "camera.context.fusion-import",
        filename: core,
        symbol: "adsk",
        importName: "adsk.fusion",
      },
      {
        id: "camera.context.target",
        filename: identity,
        symbol: "_document_target",
      },
      {
        id: "camera.context.assert",
        filename: identity,
        symbol: "_document_assert_identity",
      },
      {
        id: "camera.context.data-file",
        filename: identity,
        symbol: "_document_data_file",
      },
    ],
    typingReferences: [
      {
        id: "camera.context.type.identity-guard",
        filename: identity,
        symbol: "_Identity_TYPE_CHECKING",
        importName: "typing.TYPE_CHECKING",
      },
      {
        id: "camera.context.type.identity-protocol",
        filename: identity,
        symbol: "_IdentityProtocol",
        importName: "typing.Protocol",
      },
      ...[
        "_IdentityDataProject",
        "_IdentityDataFolder",
        "_IdentityDataFile",
        "_IdentityDocumentReferences",
        "_IdentityDocument",
        "_IdentityDocuments",
        "_IdentityApplication",
      ].map((symbol) => ({
        id: `camera.context.type.${symbol}`,
        filename: identity,
        symbol,
        guard: "_Identity_TYPE_CHECKING",
      })),
      {
        id: "camera.context.type.fusion-guard",
        filename: fusionTyping,
        symbol: "_TYPE_CHECKING",
        importName: "typing.TYPE_CHECKING",
      },
      {
        id: "camera.context.type.fusion-protocol",
        filename: fusionTyping,
        symbol: "_FusionProtocol",
        importName: "typing.Protocol",
      },
      {
        id: "camera.context.type.design-caster",
        filename: fusionTyping,
        symbol: "_DesignCaster",
        guard: "_TYPE_CHECKING",
      },
    ],
  };
}
