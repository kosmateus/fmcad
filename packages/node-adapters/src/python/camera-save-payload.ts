import {
  planCadScript,
  cameraSelector,
  type CadContext,
  type CameraAliasObservation,
} from "@fmcad/core";
import {
  cameraSaveHandlerPlan,
  cameraSaveCanonicalSources,
  cameraSaveTypingSources,
} from "./camera-read-registry.js";
import { planCameraSaveContext } from "./camera-context-registry.js";
import { cameraComponentNamePlan } from "./camera-component-registry.js";
import { planCameraAlias } from "./camera-alias-registry.js";
import { planCameraToken } from "./camera-token-registry.js";
import { prepareCanonicalRegisteredPayload } from "./registered-payload.js";
import { preparePythonArtifact, pythonLiteral } from "./artifact.js";
import type { PythonArtifactManifest } from "@fmcad/core";
import { eraseRegisteredPython } from "./registered-erasure.js";

function aliasPlan(
  root: string,
  context: CadContext,
  alias?: CameraAliasObservation,
) {
  if (alias?.absent) return null;
  const raw =
    alias?.raw ??
    (context.component != null && typeof context.component === "object"
      ? JSON.stringify(context.component)
      : undefined);
  if (raw === undefined) return null;
  const token = !alias?.observed?.length && planCameraToken(root, raw);
  if (token) {
    // Eligibility is certified by the canonical projector; do not infer it
    // merely because the requested JSON says "component".
    const kind = token.alwaysEligibleAliasTarget
      ? (JSON.parse(raw) as { kind: string }).kind
      : undefined;
    return {
      ...token,
      validComponent: kind === "component" || kind === "occurrence",
      contextMembers: [] as string[],
      aliasBindings: [] as ReturnType<typeof planCameraAlias>["aliasBindings"],
    };
  }
  return {
    ...planCameraAlias(raw, alias?.observed),
    receiver: "context" as const,
    alwaysEligibleAliasTarget: false,
    validComponent: false,
    projectedSources: [],
  };
}

export function cameraAliasRoute(
  root: string,
  context: CadContext,
  alias?: CameraAliasObservation,
) {
  const plan = aliasPlan(root, context, alias);
  return plan
    ? {
        resolverSymbol: plan.resolverSymbol,
        receiver: plan.receiver,
        alwaysEligibleAliasTarget: plan.alwaysEligibleAliasTarget,
        validComponent: plan.validComponent,
        simpleContext:
          plan.receiver === "context" && plan.contextMembers.length === 0,
        aliasBindings: plan.aliasBindings,
        mayDiscover: plan.definitions.some(
          (entry) => entry.symbol === "_CameraAliasRequired",
        ),
      }
    : undefined;
}

/** Single composition boundary used by both public frontends and the broker compiler. */
export function typedCameraSavePayload(
  root: string,
  wrapper: string,
  metadata: { readonly context?: unknown; readonly request?: unknown },
  cameraAlias?: CameraAliasObservation,
) {
  if (
    !metadata.context ||
    typeof metadata.context !== "object" ||
    !metadata.request ||
    typeof metadata.request !== "object" ||
    !("operation" in metadata.request) ||
    metadata.request.operation !== "camera.save"
  )
    throw new Error(
      "Registered camera read requires a camera.save request and context",
    );
  const context = metadata.context as CadContext;
  const named = typeof context.component === "string";
  const scoped = context.component != null;
  const stage = cameraSelector(context, cameraAlias);
  const aliases = aliasPlan(root, context, cameraAlias);
  const design = aliases?.receiver === "design";
  const simple = !design && aliases?.contextMembers.length === 0;
  const complex =
    (stage.kind === "alias" || stage.kind === "direct") && !simple && !design;
  const target = planCameraSaveContext(
    scoped ? { ...context, component: null } : context,
  );
  if (!target)
    throw new Error("Camera read requires a registered component resolver");
  const component = scoped
    ? cameraComponentNamePlan(
        cameraAlias || !named ? "resume-alias" : "initial",
      )
    : null;
  const typing = [
    ...cameraSaveTypingSources,
    ...target.typingReferences,
    ...(component?.typingReferences ?? []),
    ...(aliases?.typingReferences ?? []),
  ].filter(
    (ref) =>
      ref.importName !== "typing.TYPE_CHECKING" &&
      (complex ||
        !["_IdentityApplication", "_IdentityDocuments"].includes(ref.symbol)),
  );
  return prepareCanonicalRegisteredPayload(
    root,
    [
      ...cameraSaveHandlerPlan.definitions,
      ...target.definitions.map((entry) =>
        simple && entry.symbol === "CadContext"
          ? { ...entry, dependencies: [] }
          : entry,
      ),
      ...(component?.definitions ?? []),
      ...(aliases?.definitions ?? []),
    ],
    [
      ...cameraSaveCanonicalSources,
      ...target.references.map((ref) =>
        simple && ref.symbol === "CadContext"
          ? {
              id: ref.id,
              filename:
                "runtime/python/fmcad/adapters/fusion/camera_name_scope.py",
              symbol: "CadContext",
            }
          : !complex &&
              context.projectId == null &&
              ref.symbol === "_document_unique_matching"
            ? { ...ref, nullArguments: ["project_id"] }
            : ref.symbol === "CadContext" && aliases
              ? {
                  ...ref,
                  members: [
                    ...new Set([
                      ...(ref.members ?? []),
                      ...aliases.contextMembers,
                    ]),
                  ],
                  typingMembers:
                    "contextTypingMembers" in aliases
                      ? (aliases.contextTypingMembers as readonly string[])
                      : [],
                }
              : ref,
      ),
      ...(component?.references ?? []),
      ...(aliases?.references ?? []),
    ],
    [
      "adsk",
      "adsk.fusion",
      ...(complex
        ? target.roots
        : [
            "_document_unique_matching",
            ...(context.docFileId != null ? ["_document_file_pin"] : []),
          ]),
      ...(stage.kind === "discover"
        ? ["_camera_scope_attribute"]
        : stage.kind === "reserved"
          ? ["_camera_require_component"]
          : stage.kind === "plain"
            ? [
                "_camera_scope_attribute",
                "_camera_matching_names",
                "_camera_require_component",
                "_cad_unique",
              ]
            : design && named
              ? [
                  "_camera_scope_attribute",
                  "_camera_matching_names",
                  "_cad_unique",
                  ...(aliases.validComponent
                    ? []
                    : ["_camera_require_component"]),
                  ...(aliases.alwaysEligibleAliasTarget
                    ? []
                    : ["_camera_add_root_match"]),
                ]
              : named
                ? ["_camera_check_resumed_name"]
                : scoped
                  ? design && aliases.validComponent
                    ? []
                    : ["_camera_require_component"]
                  : []),
      ...(simple ? ["CadContext"] : []),
      ...(aliases?.roots ?? []),
      ...(stage.kind === "discover" ? [] : cameraSaveHandlerPlan.roots),
    ],
    target.conditions,
    {
      id: "wrapper",
      filename: "<fmcad-wrapper>",
      role: "wrapper",
      source: wrapper,
    },
    metadata,
    typing,
    aliases?.projectedSources ?? [],
  );
}

function cameraArtifact(
  root: string,
  typed: ReturnType<typeof typedCameraSavePayload>,
  metadata: { context?: unknown; request?: unknown },
  alias: CameraAliasObservation | undefined,
  addin: boolean,
) {
  const source = eraseRegisteredPython(root, typed.script).trimEnd();
  return preparePythonArtifact(
    [
      {
        id: "camera.save",
        filename: "<registered-camera.save>",
        role: "wrapper",
        source,
      },
    ],
    {
      request: metadata.request,
      context: {
        ...(metadata.context as CadContext),
        registeredCamera: {
          version: 1,
          typedHash: typed.sha256,
          ...(addin ? { addin: true } : {}),
          ...(alias ? { alias } : {}),
        },
      },
    },
  );
}

export function prepareCameraSavePayload(
  ...args: Parameters<typeof typedCameraSavePayload>
) {
  return cameraArtifact(
    args[0],
    typedCameraSavePayload(...args),
    args[2],
    args[3],
    false,
  );
}

function row(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Rebuild from logical inputs, not arbitrary caller-provided source or type hints. */
function canonicalCamera(
  root: string,
  candidate: unknown,
  addinOverride?: boolean,
) {
  const record = row(candidate),
    ctx = row(record["context"]),
    req = row(record["request"]);
  const descriptor = row(ctx["registeredCamera"]);
  if (descriptor["version"] !== 1 || req["operation"] !== "camera.save")
    return null;
  const context: CadContext = {};
  for (const key of [
    "doc",
    "docId",
    "docFileId",
    "projectId",
    "component",
  ] as const) {
    const v = req[key];
    if (v == null) continue;
    if (
      key === "component" &&
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      JSON.stringify(v) === JSON.stringify(ctx[key])
    ) {
      context.component = v as Record<string, unknown>;
      continue;
    }
    if (typeof v !== "string" || v !== ctx[key])
      throw new Error("Invalid registered camera target");
    context[key] = v;
  }
  if (
    !req["data"] ||
    typeof req["data"] !== "object" ||
    Object.keys(req["data"]).length
  )
    throw new Error("Invalid registered camera inputs");
  const alias = descriptor["alias"] as CameraAliasObservation | undefined;
  const plan = planCadScript(
    "camera.save",
    {},
    context,
    {
      summary: "",
      example: {},
      inputs: {},
      readOnly: true,
      required: [],
      limitations: [],
    },
    pythonLiteral,
    undefined,
    alias,
    cameraAliasRoute(root, context, alias),
  );
  const addin = addinOverride ?? descriptor["addin"] === true;
  const wrapper = addin
    ? plan.wrapper.replace(/^def run\(_context: str\):/, "def run():")
    : plan.wrapper;
  const typed = typedCameraSavePayload(
    root,
    wrapper,
    { context, request: plan.request },
    alias,
  );
  if (addinOverride === undefined && typed.sha256 !== descriptor["typedHash"])
    throw new Error("Canonical camera source changed");
  return {
    typed,
    source: eraseRegisteredPython(root, typed.script).trimEnd(),
    context,
    request: plan.request,
    alias,
    addin,
  };
}

export function reconstructCamera(root: string, candidate: unknown) {
  const canonical = canonicalCamera(root, candidate);
  return (
    canonical && {
      typed: canonical.typed.script,
      source: canonical.source,
      addin: canonical.addin,
    }
  );
}

export function matchesCameraInvocation(
  root: string,
  source: string,
  origin: unknown,
  invocation: unknown,
) {
  const target = row(invocation),
    request = row(row(origin)["request"]);
  if (
    target["operation"] !== "camera.save" ||
    target["preview"] === true ||
    Object.keys(row(target["data"])).length ||
    Object.keys(row(request["data"])).length ||
    ["doc", "docId", "docFileId", "component", "projectId"].some(
      (key) => (request[key] ?? null) !== (target[key] ?? null),
    )
  )
    return false;
  const camera = reconstructCamera(root, origin);
  return camera?.addin === true && source === camera.source + "\nrun()\n";
}

/** The official SDK calls run(context); ADDIN appends its own invocation. */
export function registeredCameraForAddin(
  root: string,
  script: string,
  origin: PythonArtifactManifest,
) {
  const original = canonicalCamera(root, origin);
  if (!original) return null;
  if (original.source !== script)
    throw new Error("Camera artifact differs from registered source");
  const adapted = canonicalCamera(root, origin, true)!;
  return cameraArtifact(
    root,
    adapted.typed,
    { context: adapted.context, request: adapted.request },
    adapted.alias,
    true,
  );
}
