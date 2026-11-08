import type { ReferenceInput } from "./references";
import { clone } from "./json";
import { isObject, nonempty, boundedInteger } from "./reference-policy-types";
import type {
  ReferencePolicyInput,
  PolicyDocument,
  PolicyEdge,
  PolicySnapshot,
  ReferenceBinding,
  BindingCoverage,
} from "./reference-policy-types";
interface PolicyUpdate {
  fileId: string;
  method: string;
  fallback: null;
  reason: string;
  edgeIds: string[];
}

function edgeKey(edge: PolicyEdge) {
  if (!isObject(edge) || !nonempty(edge.edgeId))
    throw new Error("Reference edge is missing its stable edgeId");
  return edge.edgeId;
}

export function dependencyOrder(nodes: PolicyDocument[], edges: PolicyEdge[]) {
  const state = new Map<string, string>(),
    result: string[] = [],
    cycle: string[][] = [];
  const outgoing = new Map<string, string[]>(
    nodes.map((node) => [node.fileId, []]),
  );
  for (const edge of edges) {
    if (edge.selfReference === true) continue;
    if (
      outgoing.has(edge.ownerFileId) &&
      nodes.some((node) => node.fileId === edge.sourceFileId)
    ) {
      outgoing.get(edge.ownerFileId)!.push(edge.sourceFileId);
    }
  }
  function visit(fileId: string, pathStack: string[]) {
    const mark = state.get(fileId);
    if (mark === "done") return;
    if (mark === "visiting") {
      cycle.push([...pathStack, fileId]);
      return;
    }
    state.set(fileId, "visiting");
    for (const child of outgoing.get(fileId) ?? [])
      visit(child, [...pathStack, fileId]);
    state.set(fileId, "done");
    result.push(fileId);
  }
  for (const node of nodes) visit(node.fileId, []);
  return { order: result, cycles: cycle };
}

export function explicitBindingCoverage(
  edge: PolicyEdge,
  document: PolicyDocument,
  bindings: ReferenceBinding[],
): BindingCoverage {
  const derived = Array.isArray(edge.derivedParameters)
    ? edge.derivedParameters
    : [];
  if (!derived.length)
    return {
      complete: true,
      expected: [],
      mapped: [],
      valuesMatch: true,
      valueMismatches: [],
    };
  const sourceNames = new Set(
    (edge.sourceParameters ?? []).map((row) => row.name),
  );
  const aliases = new Map(
    (document.parameters ?? [])
      .filter((row) => row?.name)
      .map((row) => [row.name, row]),
  );
  const candidates = bindings.filter(
    (binding) => binding.edgeId === edge.edgeId,
  );
  const mapped: BindingCoverage["mapped"] = [];
  for (const binding of candidates) {
    if (!sourceNames.has(binding.sourceParameter)) continue;
    let nativeName = binding.nativeDerivedParameter;
    if (nativeName && !derived.some((row) => row.name === nativeName)) continue;
    if (!nativeName && binding.consumerAlias) {
      const alias = aliases.get(binding.consumerAlias);
      if (!alias) continue;
      const matches = derived.filter(
        (row) =>
          alias.expression === row.name ||
          (Array.isArray(alias.dependsOn) &&
            alias.dependsOn.includes(row.name)),
      );
      if (matches.length !== 1) continue;
      nativeName = matches[0]!.name;
    }
    if (!nativeName) continue;
    if (binding.consumerAlias) {
      const alias = aliases.get(binding.consumerAlias);
      if (
        !alias ||
        !(
          alias.expression === nativeName ||
          (Array.isArray(alias.dependsOn) &&
            alias.dependsOn.includes(nativeName))
        )
      )
        continue;
    }
    mapped.push({
      sourceParameter: binding.sourceParameter,
      nativeDerivedParameter: nativeName,
      consumerAlias: binding.consumerAlias ?? null,
    });
  }
  const mappedNames = new Set(mapped.map((row) => row.nativeDerivedParameter));
  const complete =
    mapped.length === candidates.length &&
    derived.every((row) => mappedNames.has(row.name)) &&
    mapped.length === derived.length;
  const valueMismatches: Record<string, unknown>[] = [];
  let valuesUnknown = false;
  for (const binding of mapped) {
    const source = (edge.sourceParameters ?? []).find(
      (row) => row.name === binding.sourceParameter,
    );
    const target = derived.find(
      (row) => row.name === binding.nativeDerivedParameter,
    );
    if (
      !source ||
      !target ||
      source.internal_unit !== target.internal_unit ||
      source.internal_value === undefined ||
      target.internal_value === undefined
    ) {
      valuesUnknown = true;
      continue;
    }
    const matches =
      typeof source.internal_value === "number" &&
      typeof target.internal_value === "number"
        ? Math.abs(source.internal_value - target.internal_value) <=
          1e-9 * Math.max(1, Math.abs(source.internal_value))
        : source.internal_value === target.internal_value;
    if (!matches)
      valueMismatches.push({
        sourceParameter: source.name,
        nativeDerivedParameter: target.name,
        sourceValue: source.internal_value,
        derivedValue: target.internal_value,
        unit: source.internal_unit,
      });
  }
  return {
    complete,
    expected: derived.map((row) => row.name),
    mapped,
    valuesMatch:
      !complete || valuesUnknown ? null : valueMismatches.length === 0,
    valueMismatches,
  };
}

export function makePlan(value: unknown, request: ReferenceInput) {
  const input = request as ReferencePolicyInput;
  const snapshot = value as PolicySnapshot;
  if (
    !isObject(snapshot) ||
    !Array.isArray(snapshot.documents) ||
    !Array.isArray(snapshot.edges)
  ) {
    const shape = !isObject(snapshot)
      ? `type=${snapshot === null ? "null" : typeof snapshot}`
      : `object keys=${Object.keys(snapshot).sort().join(",") || "(none)"}`;
    const error: Error & { fmcadReadOnlyFailure?: string } = new Error(
      `Graph audit did not return documents and forward edges (${shape})`,
    );
    error.fmcadReadOnlyFailure = "references.refresh graph result shape";
    throw error;
  }
  const documents = snapshot.documents;
  const byId = new Map<string, PolicyDocument>();
  for (const doc of documents) {
    if (
      !nonempty(doc.fileId) ||
      !nonempty(doc.projectId) ||
      !boundedInteger(doc.version, 1, 1000000)
    ) {
      throw new Error(
        "Audited document is missing exact project/file/version identity",
      );
    }
    if (byId.has(doc.fileId))
      throw new Error(
        "Duplicate document identity in reference graph: " + doc.fileId,
      );
    byId.set(doc.fileId, doc);
  }
  const root = byId.get(input.root.fileId);
  if (
    !root ||
    root.projectId !== input.root.projectId ||
    root.version !== input.root.version
  ) {
    throw new Error(
      "Root audit does not match the exact requested project/file/version baseline",
    );
  }
  const edgeIds = new Set<string>();
  const edges: PolicyEdge[] = snapshot.edges.map((edge, edgeIndex) => {
    if (
      !isObject(edge) ||
      !byId.has(edge.ownerFileId) ||
      !nonempty(edge.sourceFileId) ||
      !nonempty(byId.get(edge.ownerFileId)!.projectId)
    ) {
      throw new Error(
        "Audited forward edge has incomplete owner/source file identity",
      );
    }
    const id = edgeKey(edge);
    const duplicateId = edgeIds.has(id);
    const resolvedEdgeId =
      duplicateId || edge.edgeIdentityUnique === false
        ? `${id}:unresolved:${edgeIndex}`
        : id;
    edgeIds.add(resolvedEdgeId);
    const explicitPin = input.pins.find(
      (pin) => pin.edgeId === resolvedEdgeId || pin.edgeId === id,
    );
    if (explicitPin && explicitPin.sourceFileId !== edge.sourceFileId)
      throw new Error("Pin sourceFileId differs from its audited edge");
    const source = byId.get(edge.sourceFileId);
    const sourceProjectId = edge.sourceProjectId ?? source?.projectId ?? null;
    const projectAllowed =
      nonempty(sourceProjectId) &&
      input.allowedProjectIds.includes(sourceProjectId);
    const pinVersion = explicitPin?.version;
    const baselineVersion = edge.baselineVersion;
    const resolved =
      Number.isSafeInteger(baselineVersion) && baselineVersion > 0;
    const latestVersion = edge.latestVersion;
    const latestKnown =
      Number.isSafeInteger(latestVersion) && latestVersion > 0;
    let targetVersion: number | null = null,
      targetVersionSource: string | null = null,
      status = edge.status ?? "current";
    if (duplicateId || edge.edgeIdentityUnique === false) status = "blocked";
    else if (!nonempty(sourceProjectId)) status = "unresolved";
    else if (!projectAllowed) status = "blocked";
    else if (status === "blocked") {
      /* keep edge identity ambiguity explicit */
    } else if (
      !resolved ||
      (edge.getterError && edge.versionSource === "unresolved")
    )
      status = "unresolved";
    else if (pinVersion !== undefined) {
      targetVersion = pinVersion;
      targetVersionSource = "explicitPin";
      status =
        pinVersion < baselineVersion ||
        (latestKnown && pinVersion > latestVersion)
          ? "blocked"
          : pinVersion === baselineVersion
            ? "pinned"
            : "outdated";
    } else if (edge.selfReference === true) {
      targetVersion = baselineVersion;
      targetVersionSource = "historicalSelfReference";
      status = "pinned";
    } else if (input.policy === "latest") {
      if (!latestKnown) status = "unresolved";
      else {
        targetVersion = latestVersion;
        targetVersionSource = "planLatest";
        status = baselineVersion === latestVersion ? "current" : "outdated";
      }
    } else {
      targetVersion = baselineVersion;
      targetVersionSource = "preservedBaseline";
      status =
        latestKnown && baselineVersion < latestVersion ? "pinned" : "current";
    }
    if (source && sourceProjectId !== source.projectId)
      throw new Error(
        "Edge source project differs from audited source document",
      );
    if (
      !source &&
      edge.selfReference !== true &&
      status !== "pinned" &&
      targetVersion !== null &&
      targetVersion !== baselineVersion
    )
      status = "unresolved";
    return {
      ...edge,
      edgeId: resolvedEdgeId,
      sourceProjectId,
      ownerProjectId:
        edge.ownerProjectId ?? byId.get(edge.ownerFileId)!.projectId,
      edgeIdentityUnique: !duplicateId && edge.edgeIdentityUnique !== false,
      explicitPin: pinVersion !== undefined,
      projectAllowed,
      ...(resolved ? { baselineVersion } : {}),
      ...(latestKnown ? { latestVersion } : {}),
      targetVersion,
      targetVersionSource,
      status,
      sourceAvailable: !!source,
    };
  });
  for (const pin of input.pins)
    if (!edgeIds.has(pin.edgeId))
      throw new Error(
        "Pin does not match a proven reachable forward edge: " + pin.edgeId,
      );
  for (const edge of edges)
    if (edge.kind === "derive") {
      const coverage = explicitBindingCoverage(
        edge,
        byId.get(edge.ownerFileId)!,
        input.parameterBindings,
      );
      edge.bindingCoverage = coverage;
      edge.bindingValuesMatch = coverage.valuesMatch;
      if (
        coverage.complete &&
        coverage.valuesMatch === false &&
        !edge.explicitPin &&
        !edge.selfReference &&
        edge.targetVersion !== null &&
        !["blocked", "unresolved"].includes(edge.status)
      ) {
        edge.bindingValueMismatch = true;
        // A value mismatch without a version advance is not an update request.
        // Repeating Update All on an already-current Derive is not a repair.
        if (edge.baselineVersion === edge.targetVersion) {
          edge.status = "blocked";
          edge.blockedReason = "currentVersionBindingMismatch";
        } else edge.status = "outdated";
      }
    }
  const reachableFromRoot = new Set([input.root.fileId]);
  let reachChanged = true;
  while (reachChanged) {
    reachChanged = false;
    for (const edge of edges)
      if (
        !edge.selfReference &&
        reachableFromRoot.has(edge.ownerFileId) &&
        byId.has(edge.sourceFileId) &&
        !reachableFromRoot.has(edge.sourceFileId)
      ) {
        reachableFromRoot.add(edge.sourceFileId);
        reachChanged = true;
      }
  }
  const rootScope = input.scopeFileId ?? input.root.fileId;
  if (!reachableFromRoot.has(rootScope))
    throw new Error("scopeFileId is not proven reachable from the pinned root");
  const selected = new Set([rootScope]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges)
      if (
        !edge.selfReference &&
        selected.has(edge.ownerFileId) &&
        byId.has(edge.sourceFileId) &&
        !selected.has(edge.sourceFileId)
      ) {
        selected.add(edge.sourceFileId);
        changed = true;
      }
  }
  const selectedDocs = documents.filter((doc) => selected.has(doc.fileId));
  const limitedIds = new Set(
    selectedDocs.slice(0, input.maxFiles).map((doc) => doc.fileId),
  );
  const scopedDocs = selectedDocs.filter((doc) => limitedIds.has(doc.fileId));
  const scopedEdges = edges.filter((edge) => limitedIds.has(edge.ownerFileId));
  const ordered = dependencyOrder(scopedDocs, scopedEdges);
  for (const cycle of ordered.cycles) {
    const cycleNodes = new Set(cycle);
    for (const doc of scopedDocs)
      if (cycleNodes.has(doc.fileId)) doc.referenceCycle = true;
    for (const edge of scopedEdges)
      if (cycleNodes.has(edge.ownerFileId) && cycleNodes.has(edge.sourceFileId))
        edge.status = "blocked";
  }
  const updates: PolicyUpdate[] = [],
    blocked: Record<string, unknown>[] = [],
    skipped: { fileId: string; reason: string }[] = [];
  for (const fileId of ordered.order) {
    const doc = byId.get(fileId)!;
    const outgoing = scopedEdges.filter((edge) => edge.ownerFileId === fileId);
    const unknownEdge = outgoing.some((edge) =>
      ["unresolved", "blocked"].includes(edge.status),
    );
    const health = doc.health ?? doc.history ?? {};
    const incoming = scopedEdges.filter(
      (edge) => !edge.selfReference && edge.sourceFileId === fileId,
    );
    const pinnedDependency =
      fileId !== rootScope &&
      incoming.length > 0 &&
      incoming.every(
        (edge) =>
          edge.status === "pinned" && edge.targetVersion === doc.version,
      ) &&
      outgoing.every(
        (edge) =>
          ["current", "pinned"].includes(edge.status) &&
          !edge.bindingValueMismatch,
      );
    const repairRequired =
      doc.repairRequired === true ||
      health.repairRequired === true ||
      health.healthy !== true ||
      doc.consumedBodiesVerified === false ||
      doc.historySnapshotSupported === false;
    let blocker: string | null = null;
    if (!input.allowedProjectIds.includes(doc.projectId))
      blocker = "projectNotAllowed";
    else if (doc.referenceCycle === true) blocker = "referenceCycle";
    else if (doc.available !== true) blocker = "documentUnavailable";
    else if (
      !Number.isSafeInteger(doc.version) ||
      !Number.isSafeInteger(doc.latestVersion)
    )
      blocker = "cloudVersionUnresolved";
    else if (doc.dirty !== false && doc.modified !== false)
      blocker = "dirtyOrModifiedStatusUnknown";
    else if (
      Number.isSafeInteger(doc.latestVersion) &&
      doc.version !== doc.latestVersion &&
      !pinnedDependency
    )
      blocker = "olderRevisionOpen";
    else if (doc.isComplete !== true) blocker = "cloudIncompleteOrUnknown";
    else if (doc.readOnly !== false) blocker = "uneditableOrUnknown";
    else if (doc.timelineAtEnd !== true || doc.pendingSnapshot !== false)
      blocker = "historyPositionNotReadyOrUnknown";
    else if (repairRequired) blocker = "repairRequired";
    else if (
      outgoing.some(
        (edge) => edge.blockedReason === "currentVersionBindingMismatch",
      )
    )
      blocker = "repairRequired";
    else if (unknownEdge)
      blocker = outgoing.some((edge) => edge.status === "blocked")
        ? "edgeConflictOrOutOfScope"
        : "unresolvedReferenceVersion";
    const bySourceTargets = new Map<string, Set<number>>();
    for (const edge of outgoing.filter(
      (edge) => !edge.selfReference && edge.targetVersion !== null,
    )) {
      if (!bySourceTargets.has(edge.sourceFileId))
        bySourceTargets.set(edge.sourceFileId, new Set());
      bySourceTargets.get(edge.sourceFileId)!.add(edge.targetVersion!);
    }
    if (
      [...bySourceTargets.values()].some((versions) => versions.size > 1) &&
      outgoing.some((edge) => edge.kind === "derive")
    ) {
      doc.blocked = true;
      doc.blockedReason = "multipleVersionsOfOneDeriveSource";
      blocked.push({ fileId, reason: doc.blockedReason });
      continue;
    }
    const stale = outgoing.filter(
      (edge) =>
        !edge.selfReference &&
        edge.status !== "pinned" &&
        edge.targetVersion !== null &&
        (edge.baselineVersion !== edge.targetVersion ||
          edge.bindingValueMismatch === true),
    );
    const blockedDependency = outgoing.some(
      (edge) =>
        edge.sourceAvailable && byId.get(edge.sourceFileId)?.blocked === true,
    );
    if (!blocker && blockedDependency) blocker = "blockedDependency";
    if (blocker) {
      doc.blocked = true;
      doc.blockedReason = blocker;
      blocked.push({ fileId, reason: blocker });
      continue;
    }
    if (!stale.length) {
      skipped.push({ fileId, reason: "alreadyAtIntendedTargets" });
      continue;
    }
    const linked = outgoing.filter(
      (edge) =>
        edge.kind === "linked" &&
        edge.status !== "pinned" &&
        edge.isOccurrenceReference !== false,
    );
    const derives = outgoing.filter(
      (edge) => edge.kind === "derive" && edge.status !== "pinned",
    );
    const staleDerives = stale.filter((edge) => edge.kind === "derive");
    const incompleteBinding = staleDerives.find(
      (edge) =>
        !explicitBindingCoverage(edge, doc, input.parameterBindings).complete,
    );
    if (incompleteBinding) {
      doc.blocked = true;
      doc.blockedReason = "explicitParameterBindingsRequired";
      blocked.push({
        fileId,
        edgeId: incompleteBinding.edgeId,
        reason: doc.blockedReason,
        bindingCoverage: explicitBindingCoverage(
          incompleteBinding,
          doc,
          input.parameterBindings,
        ),
      });
      continue;
    }
    const unknownKinds = outgoing.filter(
      (edge) => !["linked", "derive"].includes(edge.kind),
    );
    if (unknownKinds.length) {
      doc.blocked = true;
      doc.blockedReason = "unsupportedReferenceKind";
      blocked.push({ fileId, reason: "unsupportedReferenceKind" });
      continue;
    }
    const conflictingPins = outgoing.some(
      (edge) => edge.explicitPin || edge.status === "pinned",
    );
    const massUpdateSafe =
      !conflictingPins &&
      !outgoing.some((edge) => edge.selfReference) &&
      outgoing.every(
        (edge) =>
          edge.projectAllowed && edge.targetVersion === edge.latestVersion,
      );
    if (derives.length && linked.length) {
      if (!massUpdateSafe) {
        doc.blocked = true;
        doc.blockedReason = "mixedParentCouldAdvancePinnedOrOutOfScopeEdge";
        blocked.push({ fileId, reason: doc.blockedReason });
        continue;
      }
      const method =
        input.nativeFallback === "qualifiedOnce"
          ? "UpdateAllLatestCmd"
          : "document.updateAllReferences";
      updates.push({
        fileId,
        method,
        fallback: null,
        reason: "mixedOwnedDeriveAndLinkedReferences",
        edgeIds: stale.map((edge) => edge.edgeId),
      });
    } else if (derives.length) {
      if (!massUpdateSafe) {
        doc.blocked = true;
        doc.blockedReason = "deriveUpdateCouldAdvancePinnedOrOutOfScopeEdge";
        blocked.push({ fileId, reason: doc.blockedReason });
        continue;
      }
      updates.push({
        fileId,
        method: "document.updateAllReferences",
        fallback: null,
        reason: "ownedDeriveReferences",
        edgeIds: stale.map((edge) => edge.edgeId),
      });
    } else {
      updates.push({
        fileId,
        method: "DocumentReference.getLatestVersion",
        fallback: null,
        reason: "edgeScopedLinkedReferences",
        edgeIds: stale.map((edge) => edge.edgeId),
      });
    }
  }
  const truncatedFiles = selectedDocs
    .filter((doc) => !limitedIds.has(doc.fileId))
    .map((doc) => doc.fileId);
  const limitedUpdates = updates.slice(0, input.maxUpdates);
  const updateLimited = updates.length > limitedUpdates.length;
  const notPlanned = [
    ...truncatedFiles,
    ...(updateLimited
      ? updates.slice(limitedUpdates.length).map((row) => row.fileId)
      : []),
  ];
  const updateById = new Map(
    limitedUpdates.map((update) => [update.fileId, update]),
  );
  const blockedById = new Map(blocked.map((row) => [row["fileId"], row]));
  const skippedById = new Map(skipped.map((row) => [row.fileId, row]));
  const plannedDocuments = scopedDocs.map((doc) => ({
    ...doc,
    baselineVersion: doc.version,
    resultingVersion: null,
    identityBefore: {
      projectId: doc.projectId,
      fileId: doc.fileId,
      version: doc.version,
      creationId: doc.creationId ?? null,
    },
    identityAfter: null,
    method: updateById.get(doc.fileId)?.method ?? null,
    status: blockedById.has(doc.fileId)
      ? "blocked"
      : skippedById.has(doc.fileId)
        ? "up_to_date"
        : updateById.has(doc.fileId)
          ? "planned"
          : "notProcessed",
    saveStatus: "notStarted",
    coldVerified: null,
    commandReceipt: null,
  }));
  return {
    schemaVersion: 1,
    root: { ...input.root },
    scopeFileId: rootScope,
    policy: input.policy,
    lifecycle: input.lifecycle,
    nativeFallback: input.nativeFallback,
    durability: input.durability,
    requestId: input.requestId,
    options: {
      pins: clone(input.pins),
      allowedProjectIds: [...input.allowedProjectIds],
      parameterBindings: clone(input.parameterBindings),
      callerNamespaces: clone(input.callerNamespaces),
      maxFiles: input.maxFiles,
      maxUpdates: input.maxUpdates,
      timeBudgetMs: input.timeBudgetMs,
    },
    documents: plannedDocuments,
    edges: scopedEdges,
    order: ordered.order,
    cycles: ordered.cycles,
    updates: limitedUpdates,
    blocked,
    skipped,
    notPlanned,
    limits: {
      maxFiles: input.maxFiles,
      maxUpdates: input.maxUpdates,
      totalReachableFiles: selectedDocs.length,
      plannedFiles: scopedDocs.length,
      requestedUpdates: updates.length,
      plannedUpdates: limitedUpdates.length,
    },
    graphComplete:
      snapshot.graphComplete === true &&
      scopedDocs.every((doc) => doc.available !== false) &&
      !truncatedFiles.length,
    allIntendedReferencesCurrent: scopedEdges.some(
      (edge) =>
        edge.status === "unresolved" ||
        (edge.kind === "derive" &&
          (edge.bindingCoverage?.valuesMatch === null ||
            edge.bindingReadError)),
    )
      ? null
      : updates.length ||
          blocked.length ||
          scopedEdges.some((edge) => edge.status === "outdated")
        ? false
        : true,
    allReferencesLatest: scopedEdges.some(
      (edge) =>
        edge.status === "unresolved" ||
        !Number.isSafeInteger(edge.latestVersion),
    )
      ? null
      : scopedEdges.every(
          (edge) =>
            edge.selfReference || edge.baselineVersion === edge.latestVersion,
        ),
    getterErrors: snapshot.getterErrors ?? [],
    lifecycleEffects: snapshot.lifecycleEffects ?? [],
    coverage: snapshot.coverage ?? {},
    environment: snapshot.environment ?? {
      backend: null,
      fusionVersion: null,
      osBuild: null,
      locale: null,
      adapterQualification: null,
    },
  };
}
