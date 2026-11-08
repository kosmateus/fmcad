import { hash } from "./json";
import { isObject, nonempty, boundedInteger } from "./reference-policy-types";
import type { ReferencePolicyInput } from "./reference-policy-types";

const phases = new Set(["audit", "plan", "apply", "inspect"]);
const policies = new Set(["preserve", "latest"]);
const lifecycles = new Set(["existingOnly", "openOwned"]);
const fallbackModes = new Set(["never", "qualifiedOnce"]);
const durabilities = new Set(["cloud", "cold"]);

export function validate(value: unknown): ReferencePolicyInput;
export function validate(
  value: unknown,
  operation: string,
): ReferencePolicyInput | undefined;
export function validate(
  value: unknown,
  operation?: string,
): ReferencePolicyInput | undefined {
  const data = value as ReferencePolicyInput;
  if (operation !== undefined && operation !== "references.refresh") return;
  if (!isObject(data))
    throw new Error("references.refresh data must be an object");
  const allowed = new Set([
    "schemaVersion",
    "phase",
    "root",
    "scopeFileId",
    "policy",
    "pins",
    "allowedProjectIds",
    "lifecycle",
    "nativeFallback",
    "durability",
    "parameterBindings",
    "callerNamespaces",
    "maxFiles",
    "maxUpdates",
    "timeBudgetMs",
    "requestId",
    "planId",
    "reportPath",
    "confirm",
    "uiLeases",
  ]);
  for (const key of Object.keys(data))
    if (!allowed.has(key))
      throw new Error(`Unknown references.refresh input: ${key}`);
  if (data.schemaVersion !== 1)
    throw new Error("references.refresh schemaVersion must be 1");
  const phase = data.phase ?? "audit";
  if (!phases.has(phase))
    throw new Error("phase must be audit, plan, apply or inspect");
  if (
    !isObject(data.root) ||
    Object.keys(data.root).some(
      (k) => !["projectId", "fileId", "version"].includes(k),
    ) ||
    !nonempty(data.root["projectId"]) ||
    !nonempty(data.root["fileId"]) ||
    !boundedInteger(data.root["version"], 1, 1000000)
  ) {
    throw new Error(
      "root must be the exact saved {projectId,fileId,version} baseline",
    );
  }
  if (data.scopeFileId !== undefined && !nonempty(data.scopeFileId))
    throw new Error("scopeFileId must be an exact nonempty file ID");
  if (data.policy !== undefined && !policies.has(data.policy))
    throw new Error("policy must be preserve or latest");
  if (
    phase !== "apply" &&
    phase !== "inspect" &&
    Object.hasOwn(data, "confirm")
  )
    throw new Error("confirm is accepted only by apply");
  if (phase === "apply" && data.confirm !== true)
    throw new Error("apply requires confirm:true");
  if (phase === "plan" && !policies.has(data.policy))
    throw new Error("plan requires an explicit policy: preserve or latest");
  if (data.lifecycle !== undefined && !lifecycles.has(data.lifecycle))
    throw new Error("lifecycle must be existingOnly or openOwned");
  if (
    data.nativeFallback !== undefined &&
    !fallbackModes.has(data.nativeFallback)
  )
    throw new Error("nativeFallback must be never or qualifiedOnce");
  if (data.durability !== undefined && !durabilities.has(data.durability))
    throw new Error("durability must be cloud or cold");
  if (
    !nonempty(data.requestId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.requestId)
  ) {
    throw new Error(
      "requestId must contain 1..128 letters, digits, underscores or hyphens",
    );
  }
  if (!nonempty(data.reportPath))
    throw new Error("reportPath must be a nonempty local journal directory");
  if ((phase === "apply" || phase === "inspect") && !nonempty(data.planId)) {
    if (phase === "apply") throw new Error("apply requires planId");
  }
  if (data.planId !== undefined && !/^[0-9a-f]{64}$/.test(data.planId))
    throw new Error("planId must be an exact SHA-256 plan identifier");
  for (const [key, value, max] of [
    ["maxFiles", data.maxFiles, 1000],
    ["maxUpdates", data.maxUpdates, 1000],
    ["timeBudgetMs", data.timeBudgetMs, 1200000],
  ] as const) {
    if (value !== undefined && !boundedInteger(value, 1, max))
      throw new Error(`${key} must be an integer in 1..${max}`);
  }
  if (
    data.maxUpdates !== undefined &&
    data.maxFiles !== undefined &&
    data.maxUpdates > data.maxFiles
  ) {
    throw new Error("maxUpdates cannot exceed maxFiles");
  }
  if (
    data.allowedProjectIds !== undefined &&
    (!Array.isArray(data.allowedProjectIds) ||
      data.allowedProjectIds.some((id) => !nonempty(id)) ||
      new Set(data.allowedProjectIds).size !== data.allowedProjectIds.length)
  ) {
    throw new Error("allowedProjectIds must contain unique exact project IDs");
  }
  if (
    data.allowedProjectIds &&
    !data.allowedProjectIds.includes(data.root["projectId"])
  ) {
    throw new Error("allowedProjectIds must include the pinned root projectId");
  }
  if (
    data.pins !== undefined &&
    (!Array.isArray(data.pins) ||
      data.pins.some(
        (pin) =>
          !isObject(pin) ||
          Object.keys(pin).some(
            (k) => !["edgeId", "sourceFileId", "version"].includes(k),
          ) ||
          !nonempty(pin.edgeId) ||
          !nonempty(pin.sourceFileId) ||
          !boundedInteger(pin.version, 1, 1000000),
      ))
  ) {
    throw new Error(
      "pins must be [{edgeId,sourceFileId,version}] with exact IDs and positive versions",
    );
  }
  if (
    data.pins &&
    new Set(data.pins.map((pin) => pin.edgeId)).size !== data.pins.length
  ) {
    throw new Error("pins must contain at most one version per edgeId");
  }
  if (
    data.parameterBindings !== undefined &&
    (!Array.isArray(data.parameterBindings) ||
      data.parameterBindings.some(
        (binding) =>
          !isObject(binding) ||
          Object.keys(binding).some(
            (k) =>
              ![
                "edgeId",
                "sourceParameter",
                "consumerAlias",
                "nativeDerivedParameter",
              ].includes(k),
          ) ||
          !nonempty(binding.edgeId) ||
          !nonempty(binding.sourceParameter) ||
          (!nonempty(binding.consumerAlias) &&
            !nonempty(binding.nativeDerivedParameter)),
      ))
  ) {
    throw new Error(
      "parameterBindings require edgeId, sourceParameter and a caller-named consumerAlias or nativeDerivedParameter",
    );
  }
  if (data.callerNamespaces !== undefined && !isObject(data.callerNamespaces)) {
    throw new Error(
      "callerNamespaces must be an object of opaque caller-supplied context namespaces",
    );
  }
  if (
    data.uiLeases !== undefined &&
    (!isObject(data.uiLeases) ||
      Object.entries(data.uiLeases).some(
        ([fileId, entry]) =>
          !nonempty(fileId) ||
          !isObject(entry) ||
          !isObject(entry["target"]) ||
          !isObject(entry["lease"]) ||
          entry["target"].fileId !== fileId ||
          !nonempty(entry["target"].name) ||
          (entry["target"].creationId !== undefined &&
            !nonempty(entry["target"].creationId)) ||
          (entry["target"].commandId !== undefined &&
            entry["target"].commandId !== null) ||
          entry["lease"].requestId !== data.requestId ||
          !nonempty(entry["lease"].id) ||
          !nonempty(entry["lease"].operationId) ||
          !Number.isSafeInteger(entry["lease"].expiresAt) ||
          !isObject(entry["lease"].target) ||
          hash(entry["lease"].target) !== hash(entry["target"]),
      ))
  ) {
    throw new Error(
      "uiLeases must map exact file IDs to .11 leases bound to this requestId and exact target identity",
    );
  }
  if (
    phase === "apply" &&
    inputNativeFallback(data) &&
    data.uiLeases !== undefined &&
    Object.keys(data.uiLeases).some((fileId) => !nonempty(fileId))
  )
    throw new Error("uiLeases keys must be exact file IDs");
  return {
    ...data,
    phase,
    lifecycle: data.lifecycle ?? "existingOnly",
    nativeFallback: data.nativeFallback ?? "never",
    policy: data.policy ?? "preserve",
    durability: data.durability ?? (phase === "apply" ? "cold" : "cold"),
    allowedProjectIds: data.allowedProjectIds ?? [data.root["projectId"]],
    maxFiles: data.maxFiles ?? 100,
    maxUpdates: data.maxUpdates ?? data.maxFiles ?? 100,
    timeBudgetMs: data.timeBudgetMs ?? 180000,
    pins: data.pins ?? [],
    parameterBindings: data.parameterBindings ?? [],
    callerNamespaces: data.callerNamespaces ?? {},
  };
}

export function inputNativeFallback(
  data: Pick<ReferencePolicyInput, "nativeFallback">,
) {
  return (data.nativeFallback ?? "never") === "qualifiedOnce";
}
