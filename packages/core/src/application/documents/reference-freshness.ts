import type { ReferencePlan } from "./references";
import { hash } from "./json";
import { isObject } from "./reference-policy-types";
import { explicitBindingCoverage } from "./reference-plan";
import type { makePlan } from "./reference-plan";
import type {
  PolicyDocument,
  PolicyEdge,
  PolicySnapshot,
  ReferenceBinding,
  ReferenceParameter,
} from "./reference-policy-types";

function bindingEvidenceMatches(
  edge: PolicyEdge,
  currentEdge: PolicyEdge,
  baseline: PolicyDocument,
  current: PolicyDocument,
  bindings: ReferenceBinding[],
) {
  const binding = explicitBindingCoverage(currentEdge, current, bindings);
  if (binding.complete !== edge.bindingCoverage?.complete) return false;
  if (binding.valuesMatch === edge.bindingValuesMatch) return true;
  // sourceDesign can expose either the saved baseline or the newly published
  // source while a stale consumer is cold-opened. Accept only that proved
  // version change, never changed consumer bindings/values or same-version drift.
  const versions = [edge.baselineVersion, edge.targetVersion];
  if (
    !(versions[1]! > versions[0]!) ||
    edge.sourceParameterVersion === currentEdge.sourceParameterVersion ||
    !versions.includes(edge.sourceParameterVersion!) ||
    !versions.includes(currentEdge.sourceParameterVersion!) ||
    edge.sourceParameterFileId !== edge.sourceFileId ||
    currentEdge.sourceParameterFileId !== edge.sourceFileId ||
    edge.sourceDocumentModified !== false ||
    currentEdge.sourceDocumentModified !== false
  )
    return false;
  const rows = (values: ReferenceParameter[] | undefined) =>
    (values ?? [])
      .map((row) => ({
        name: row.name,
        expression: row.expression,
        internal_value: row.internal_value,
        internal_unit: row.internal_unit,
        dependsOn: row.dependsOn ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const aliases = new Set(
    bindings
      .filter((row) => row.edgeId === edge.edgeId)
      .map((row) => row.consumerAlias)
      .filter(Boolean),
  );
  const schema = (values: ReferenceParameter[] | undefined) =>
    rows(values).map(({ name, internal_unit }) => ({ name, internal_unit }));
  return (
    hash(rows(edge.derivedParameters)) ===
      hash(rows(currentEdge.derivedParameters)) &&
    hash(
      rows((baseline.parameters ?? []).filter((row) => aliases.has(row.name))),
    ) ===
      hash(
        rows((current.parameters ?? []).filter((row) => aliases.has(row.name))),
      ) &&
    hash(schema(edge.sourceParameters)) ===
      hash(schema(currentEdge.sourceParameters))
  );
}

export function staleBeforeStep(
  storedPlan: ReferencePlan,
  freshValue: unknown,
  fileId: string,
  effectiveTargets: Record<string, number | undefined> = {},
) {
  const plan = storedPlan as ReturnType<typeof makePlan>;
  const freshSnapshot = freshValue as PolicySnapshot;
  const baseline = plan.documents.find((doc) => doc.fileId === fileId);
  const current =
    freshSnapshot.documents?.find((doc) => doc.fileId === fileId) ??
    (freshSnapshot.document?.fileId === fileId ? freshSnapshot.document : null);
  if (!baseline || !current)
    return {
      reason: "documentUnavailable",
      preflight: {
        status: freshSnapshot?.status ?? null,
        reason: freshSnapshot?.reason ?? null,
        error: freshSnapshot?.error ?? null,
        identity: freshSnapshot?.identity ?? null,
      },
    };
  const currentHealth = current.health ?? current.history ?? {};
  for (const key of ["projectId", "fileId", "version"] as const)
    if (baseline[key] !== current[key]) return "identityOrVersionDrift";
  if (
    Number.isSafeInteger(baseline.latestVersion) &&
    Number.isSafeInteger(current.latestVersion) &&
    baseline.latestVersion !== current.latestVersion
  )
    return "unrelatedRevisionDrift";
  if (
    current.modified !== false ||
    current.isComplete !== true ||
    current.readOnly !== false ||
    current.timelineAtEnd !== true ||
    current.pendingSnapshot !== false ||
    currentHealth.healthy !== true
  )
    return "documentPreconditionChanged";
  const plannedEdges = plan.edges.filter((edge) => edge.ownerFileId === fileId);
  const currentEdges = new Map(
    (freshSnapshot.edges ?? [])
      .filter((edge) => edge.ownerFileId === fileId)
      .map((edge) => [edge.edgeId, edge]),
  );
  for (const edge of plannedEdges) {
    const now = currentEdges.get(edge.edgeId);
    if (
      !now ||
      now.sourceFileId !== edge.sourceFileId ||
      now.kind !== edge.kind
    )
      return {
        reason: "edgeSetDrift",
        expectedEdgeId: edge.edgeId,
        observedEdges: [...currentEdges.values()].map((row) => ({
          edgeId: row.edgeId,
          kind: row.kind,
          sourceFileId: row.sourceFileId,
        })),
      };
    if (edge.kind === "derive") {
      if (
        !bindingEvidenceMatches(
          edge,
          now,
          baseline,
          current,
          plan.options?.parameterBindings ?? [],
        )
      ) {
        return "derivedBindingEvidenceDrift";
      }
    }
    const expected = effectiveTargets[edge.edgeId] ?? edge.targetVersion;
    if (
      now.baselineVersion !== edge.baselineVersion &&
      now.baselineVersion !== expected
    )
      return "edgeVersionDrift";
    const latestNow = now.latestVersion ?? now.sourceLatestVersion;
    const targetNow = effectiveTargets[edge.edgeId];
    if (
      latestNow !== undefined &&
      edge.latestVersion !== undefined &&
      latestNow !== (targetNow ?? edge.latestVersion)
    )
      return "unrelatedSourceVersionDrift";
  }
  return null;
}

export function planFreshness(storedPlan: ReferencePlan, value: unknown) {
  const plan = storedPlan as ReturnType<typeof makePlan>;
  const snapshot = value as PolicySnapshot;
  const blockers: Record<string, unknown>[] = [];
  if (
    !isObject(snapshot) ||
    !Array.isArray(snapshot.documents) ||
    !Array.isArray(snapshot.edges)
  ) {
    blockers.push({ reason: "auditGraphUnavailable" });
    return blockers;
  }
  const root = snapshot.documents?.find(
    (doc) => doc.fileId === plan.root.fileId,
  );
  if (
    !root ||
    root.projectId !== plan.root.projectId ||
    root.version !== plan.root.version
  ) {
    blockers.push({
      fileId: plan.root.fileId,
      reason: "rootIdentityOrVersionDrift",
    });
    return blockers;
  }
  for (const update of plan.updates) {
    const baseline = plan.documents.find((doc) => doc.fileId === update.fileId);
    const current = snapshot.documents?.find(
      (doc) => doc.fileId === update.fileId,
    );
    if (!baseline || !current) {
      blockers.push({ fileId: update.fileId, reason: "documentUnavailable" });
      continue;
    }
    const currentHealth = current.health ?? current.history ?? {};
    for (const key of [
      "projectId",
      "fileId",
      "version",
      "latestVersion",
    ] as const) {
      if (baseline[key] !== current[key])
        blockers.push({
          fileId: update.fileId,
          reason: "documentVersionDrift",
          field: key,
          expected: baseline[key],
          actual: current[key],
        });
    }
    if (
      current.modified !== false ||
      current.readOnly !== false ||
      current.isComplete !== true ||
      current.timelineAtEnd !== true ||
      current.pendingSnapshot === true ||
      currentHealth.healthy !== true
    ) {
      blockers.push({
        fileId: update.fileId,
        reason: currentHealth.repairRequired
          ? "repairRequired"
          : "documentPreconditionChanged",
      });
    }
    const plannedEdges = plan.edges.filter(
      (edge) => edge.ownerFileId === update.fileId,
    );
    const currentEdges =
      snapshot.edges?.filter((edge) => edge.ownerFileId === update.fileId) ??
      [];
    if (plannedEdges.length !== currentEdges.length)
      blockers.push({ fileId: update.fileId, reason: "forwardEdgeSetDrift" });
    const observedById = new Map(
      currentEdges.map((edge) => [edge.edgeId, edge]),
    );
    for (const edge of plannedEdges) {
      const now = observedById.get(edge.edgeId);
      if (
        !now ||
        now.sourceFileId !== edge.sourceFileId ||
        now.kind !== edge.kind ||
        now.baselineVersion !== edge.baselineVersion ||
        now.latestVersion !== edge.latestVersion
      ) {
        blockers.push({
          fileId: update.fileId,
          edgeId: edge.edgeId,
          reason: "forwardEdgeVersionDrift",
        });
        continue;
      }
      if (edge.kind === "derive") {
        if (
          !bindingEvidenceMatches(
            edge,
            now,
            baseline,
            current,
            plan.options?.parameterBindings ?? [],
          )
        ) {
          blockers.push({
            fileId: update.fileId,
            edgeId: edge.edgeId,
            reason: "derivedBindingEvidenceDrift",
          });
        }
      }
    }
  }
  return blockers;
}
