import { firstSavePublication } from "../../../core/src/application/cad/saved-first-save-publication";
import * as fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { readJson, durable } from "./records";
import { savedAuditKind, savedAuditLegacyKind } from "./saved-audit-path";
import type {
  EvidenceRef,
  SavedDocument,
  SavedEpoch,
  SourceIdentity,
  SavedRequest,
  SavedJob,
  SavedQueueState,
  Destination,
  NativeDestination,
  FirstSaveGrant,
  ObservedDocument,
  FirstSaveReply,
  SavedProof,
  AdminResult,
  IntentRecord,
  StartRecord,
  RemoteRecord,
  RpcRecord,
  NativeDestinationRecord,
  PublicationRecord,
  SavedMessage,
  SavedPorts,
  AuditController,
  SavedFixtureHost,
  ApprovalAuthority,
  FolderProof,
  FolderCreationIntent,
  FolderCreationResult,
  FolderReadback,
} from "./saved-fixture-contracts";
interface FlightRecord {
  instance?: FlightRecord;
  documentState?: {
    status: string;
    state?: { identity?: { creationId: string } };
  };
}
export function createSavedFixtureLifecycle(host: SavedFixtureHost) {
  const {
    hash,
    buildHash,
    digest,
    sameInstance,
    priorProcessAlive,
    fileHash,
    exclusive,
    epochControlDirectory,
    parseSavedFixtureReader,
    prepareSavedFixtureReader,
    settledEpochEvidence,
    createRecoveryAudit,
    verifyScratchSdkProof,
  } = host;
  function savedAdminEvidenceFail(message: string): never {
    throw Object.assign(new Error(message), {
      code: "SAVED_ADMIN_EVIDENCE_REQUIRED",
    });
  }

  function savedAdministrativeEvidence(
    root: string,
    epoch: SavedEpoch,
    receiptRef: EvidenceRef,
    evidence: EvidenceRef[],
    expected: {
      prefix: string;
      proofName: string;
      jobId: string;
      purpose: string;
      sourceCommit: string;
      buildHash: string;
    },
  ) {
    const controlRoot = epochControlDirectory(root, epoch);
    if (
      !receiptRef ||
      typeof receiptRef.path !== "string" ||
      path.dirname(path.dirname(receiptRef.path)) !== controlRoot ||
      path.basename(receiptRef.path) !== "result.json" ||
      fs.realpathSync(receiptRef.path) !== receiptRef.path ||
      fileHash(receiptRef.path).sha256 !== receiptRef.sha256 ||
      !Array.isArray(evidence) ||
      evidence.length !== 5
    )
      savedAdminEvidenceFail(
        "Exact owner administrative receipt and five-artifact evidence set required",
      );
    const result = readJson(receiptRef.path, 32 * 1024 * 1024) as AdminResult;
    if (
      typeof result.requestId !== "string" ||
      !result.requestId.trim() ||
      result.requestId.length > 180
    )
      savedAdminEvidenceFail("Exact stable administrative request required");
    const kind = savedAuditKind(expected.prefix, result.requestId),
      directory = path.join(controlRoot, kind);
    const refs = new Map(evidence.map((ref) => [ref.path, ref]));
    if (
      refs.size !== 5 ||
      receiptRef.path !== path.join(directory, "result.json")
    )
      savedAdminEvidenceFail("Administrative namespace mismatch");
    function read<T>(name: string): T {
      const file = path.join(directory, name),
        ref = refs.get(file);
      if (
        !ref ||
        fs.realpathSync(file) !== file ||
        fileHash(file).sha256 !== ref.sha256
      )
        savedAdminEvidenceFail("Administrative artifact changed");
      return readJson(file, 32 * 1024 * 1024) as T;
    }
    const intent = read<IntentRecord>("intent.json"),
      start = read<StartRecord>("start.json");
    read("wire.json");
    const proof = read<SavedProof>(expected.proofName),
      binding = intent.binding;
    if (
      result.kind !== kind ||
      result.status !== "complete" ||
      result.sdkRequestsSent !== 1 ||
      result.endpointVerified !== true ||
      result.clientId !== epoch.ownerClientId ||
      result.jobId !== expected.jobId ||
      result.nativeOutcome !== "unknown" ||
      result.modelValidation !== "not_performed" ||
      result.rollbackVerification !== "not_performed" ||
      !same(result.summary, proof) ||
      binding?.purpose !== expected.purpose ||
      binding.epochId !== epoch.epochId ||
      binding.clientId !== epoch.ownerClientId ||
      binding.ownerTokenHash !== epoch.ownerTokenHash ||
      !same(binding.document, epoch.document) ||
      !sameInstance(binding.currentInstance, epoch.currentInstance) ||
      binding.sdkProofPath !== path.join(directory, expected.proofName) ||
      binding.sourceCommit !== expected.sourceCommit ||
      binding.buildHash !== expected.buildHash ||
      !/^[a-f0-9]{64}$/.test(intent.sourceArtifactHash || "") ||
      start.binding?.auditBindingHash !== digest(binding) ||
      start.binding.pythonOriginHash !== intent.sourceArtifactHash ||
      start.binding.purpose !== expected.purpose ||
      start.binding.buildHash !== expected.buildHash ||
      start.binding.jobId !== expected.jobId ||
      !sameInstance(
        start.binding.auditExpectedInstance,
        epoch.currentInstance,
      ) ||
      start.pythonCheck?.status !== "passed" ||
      !/^[a-f0-9-]{36}$/.test(start.binding.rpcId || "") ||
      start.receipt !==
        path.join(directory, "remote-" + start.binding.rpcId + ".json")
    )
      savedAdminEvidenceFail(
        "Administrative evidence must retain exact owner/source/process/purpose binding",
      );
    const remote = read<RemoteRecord>(
      "remote-" + start.binding.rpcId + ".json",
    );
    if (
      remote.terminal !== true ||
      remote.outcome !== "succeeded" ||
      !sameInstance(remote.instance, epoch.currentInstance) ||
      Object.keys(start.binding).some(
        (key) => !same(remote[key], start.binding[key]),
      )
    )
      savedAdminEvidenceFail("Known successful physical receipt required");
    parseSavedFixtureReader(
      {
        result: {
          content: [
            { type: "text", text: "FMCAD_RESULT " + JSON.stringify(proof) },
          ],
        },
      },
      epoch.document,
      binding,
    );
    return { result, intent, start, proof, binding };
  }

  function savedDestinationApprovalFail(message: string): never {
    throw Object.assign(new Error(message), {
      code: "SAVED_DESTINATION_SCOPE_INVALID",
    });
  }

  // This validates explicit owner approval and destination evidence, not a modeling
  // grant or permission to save an existing/recovered document.
  function savedDestinationApproval(
    authorityFile: string,
    folderProofFile: string,
    ownerClientId: string,
  ): Destination {
    function read<T>(file: string, expectedHash?: string) {
      if (
        typeof file !== "string" ||
        !path.isAbsolute(file) ||
        path.resolve(file) !== file ||
        !fs.lstatSync(file).isFile() ||
        fs.realpathSync(file) !== file
      )
        savedDestinationApprovalFail(
          "Canonical regular approval/evidence file required",
        );
      const sha256 = fileHash(file).sha256;
      if (
        expectedHash !== undefined &&
        (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== sha256)
      )
        savedDestinationApprovalFail(
          "Approval or destination evidence hash changed",
        );
      return {
        reference: { path: file, sha256 },
        value: readJson(file, 1024 * 1024) as T,
      };
    }
    function reference<T>(ref: EvidenceRef) {
      if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256 || ""))
        savedDestinationApprovalFail("Hashed destination evidence required");
      return read<T>(ref.path, ref.sha256);
    }
    const authority = read<ApprovalAuthority>(authorityFile),
      proof = read<FolderProof>(folderProofFile),
      a = authority.value,
      p = proof.value;
    if (
      a.version !== 1 ||
      a.purpose !==
        "new-saved-native-fixtures-in-user-confirmed-private-project" ||
      !ownerClientId ||
      a.ownerClientId !== ownerClientId ||
      a.privacyEvidence !==
        "explicit user confirmation in current conversation; not inferred from membership" ||
      typeof a.projectName !== "string" ||
      !a.projectName.trim() ||
      typeof a.projectId !== "string" ||
      !a.projectId.startsWith("urn:adsk.workspace:") ||
      typeof a.hubId !== "string" ||
      !a.hubId ||
      !["US", "IND", "DEU"].includes(a.region) ||
      typeof a.projectUrl !== "string" ||
      !a.projectUrl.startsWith("https://") ||
      !/^FMCAD_NATIVE_\d{8}_[a-f0-9]{8}$/.test(a.folderName || "") ||
      a.scope !==
        "one separate new folder and only new qualification files; retain for user inspection; no existing-data or permission changes"
    )
      savedDestinationApprovalFail(
        "Explicit original-owner private-project and new-files-only approval required",
      );
    if (
      p.version !== 1 ||
      p.status !== "new-authorized-folder-created-once-and-read-back" ||
      p.projectName !== a.projectName ||
      p.projectId !== a.projectId ||
      p.folderName !== a.folderName ||
      typeof p.folderId !== "string" ||
      !p.folderId.startsWith("urn:adsk.wipprod:fs.folder:") ||
      p.authority?.path !== authority.reference.path ||
      p.authority?.sha256 !== authority.reference.sha256 ||
      p.dataFilesCreated !== 0 ||
      p.retention !==
        "Keep new qualification files for user inspection; no deletion or existing-data/permission changes."
    )
      savedDestinationApprovalFail(
        "Exact newly created destination and preserved retention scope required",
      );
    const intent = reference<FolderCreationIntent>(p.creationIntent),
      created = reference<FolderCreationResult>(p.creationResult),
      observed = reference<FolderReadback>(p.readback);
    const i = intent.value,
      c = created.value,
      o = observed.value;
    if (
      i.operation !== "fusion_data.create_folder" ||
      i.project_name !== a.projectName ||
      i.project_url !== a.projectUrl ||
      i.hub_id !== a.hubId ||
      i.region !== a.region ||
      i.folder_name !== a.folderName ||
      c.success !== true ||
      c.project_name !== a.projectName ||
      c.folder_id !== p.folderId ||
      o.success !== true ||
      o.tool !== "fusion_data.search_by_hub" ||
      o.query !== a.folderName ||
      !Array.isArray(o.matches) ||
      o.matches.length !== 1 ||
      o.matches[0]!.type !== "Folder" ||
      o.matches[0]!.id !== p.folderId ||
      o.matches[0]!.name !== a.folderName ||
      o.matches[0]!.projectName !== a.projectName
    )
      savedDestinationApprovalFail(
        "Folder creation and independent readback must match the exact approved destination",
      );
    return {
      version: 1,
      purpose: "validated-new-saved-fixture-destination",
      ownerClientId,
      cloudProjectId: a.projectId,
      projectName: a.projectName,
      projectUrl: a.projectUrl,
      hubId: a.hubId,
      region: a.region,
      folderName: a.folderName,
      folderId: p.folderId,
      // SDK DataProject.id is a separately observed identity, not an alias guessed
      // from a Manufacturing Data API workspace ID.
      nativeProjectId: null,
      grantIssued: false,
      existingDataChangesAllowed: false,
      retention: "keep-for-user-inspection",
      evidence: [
        authority.reference,
        proof.reference,
        intent.reference,
        created.reference,
        observed.reference,
      ],
    };
  }

  function savedFirstSaveEvidenceFail(message: string): never {
    throw Object.assign(new Error(message), {
      code: "SAVED_FIRST_SAVE_EVIDENCE_REQUIRED",
    });
  }
  const reference = (file: string): EvidenceRef => ({
    path: file,
    sha256: fileHash(file).sha256,
  });

  function firstSaveEvidence(
    root: string,
    epoch: SavedEpoch,
    expectedJobId: string,
  ) {
    const marker = markerFile(epoch),
      grant = readJson(marker) as FirstSaveGrant,
      scope = grant.savedFirstSave;
    if (
      !scope ||
      grant.epochId !== epoch.epochId ||
      !same(grant.document, epoch.document)
    )
      savedFirstSaveEvidenceFail("Exact first-save origin scope required");
    const state = readJson(
      path.join(epoch.root, "queue-state.json"),
      256 * 1024 * 1024,
    ) as SavedQueueState;
    const matches = Object.values(state.jobs).filter(
      (job) =>
        job.clientId === grant.clientId &&
        job.requestId === scope.saveRequestId,
    );
    if (matches.length !== 1 || matches[0]!.id !== expectedJobId)
      savedFirstSaveEvidenceFail("Exact original first-save job required");
    const job = matches[0]!;
    if (
      !/^[a-f0-9-]{36}$/.test(job.id) ||
      job.kind !== "command" ||
      job.state !== "succeeded" ||
      job.details?.sdkSettled !== true ||
      job.request.ownerToken !== grant.clientTokenHash ||
      !((job.dispatch?.rpcCount ?? 0) > 0) ||
      job.dispatch!.rpcCount !== job.dispatch!.completedCount
    )
      savedFirstSaveEvidenceFail(
        "Original first-save job must have known settled success",
      );
    const identity = readJson(
      path.join(epoch.root, "instance.json"),
    ) as SourceIdentity;
    firstSaveAdmission(epoch, job.request, grant, identity);
    const dir = path.join(root, "jobs", job.id),
      worker = path.join(dir, "worker-identity.json");
    if (
      priorProcessAlive(readJson(worker) as { pid: number; birth: string }) !==
      false
    )
      savedFirstSaveEvidenceFail("Original save worker must have terminated");
    const evidence = [
      reference(marker),
      reference(path.join(dir, "request.json")),
      reference(path.join(dir, "outcome.json")),
      reference(worker),
    ];
    let scripts = 0;
    for (const name of fs
      .readdirSync(dir)
      .filter(
        (name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
      )) {
      const file = path.join(dir, name),
        record = readJson(file, 128 * 1024 * 1024) as RpcRecord;
      if (!record.receipt) continue;
      scripts++;
      const binding = record.binding,
        remote = readJson(record.receipt) as RemoteRecord;
      if (
        record.terminal !== true ||
        record.failed !== false ||
        record.pythonCheck?.status !== "passed" ||
        binding?.jobId !== job.id ||
        binding.buildHash !== identity.buildHash ||
        binding.purpose !== "saved-fixture-first-save-v1" ||
        binding.auditFirstSave !== true ||
        !same(binding.auditExpectedDocument, epoch.document) ||
        !sameInstance(binding.auditExpectedInstance, epoch.currentInstance) ||
        remote.terminal !== true ||
        remote.outcome !== "succeeded" ||
        !sameInstance(remote.instance, epoch.currentInstance) ||
        Object.keys(binding).some((key) => !same(remote[key], binding[key]))
      )
        savedFirstSaveEvidenceFail(
          "Exact checked first-save physical receipt required",
        );
      evidence.push(reference(file), reference(record.receipt));
    }
    if (scripts !== 1)
      savedFirstSaveEvidenceFail("Exactly one native first-save body required");
    for (const name of ["preflight.json", "postflight.json"]) {
      const file = path.join(dir, name),
        value = readJson(file) as FlightRecord,
        observed = name === "preflight.json" ? value.instance! : value;
      if (
        observed.documentState?.status !== "complete" ||
        observed.documentState.state?.identity?.creationId !==
          epoch.document.creationId
      )
        savedFirstSaveEvidenceFail(
          "Exact first-save pre/postflight identity required",
        );
      evidence.push(reference(file));
    }
    const stdout = host.responsePath(root, job, "stdout.txt");
    if (fs.statSync(stdout).size > 1024 * 1024)
      savedFirstSaveEvidenceFail("Bounded first-save output required");
    let envelope: {
      success: boolean;
      operation: string;
      result: FirstSaveReply & ObservedDocument;
    };
    try {
      envelope = JSON.parse(fs.readFileSync(stdout, "utf8"));
    } catch {
      savedFirstSaveEvidenceFail("Original typed first-save result required");
    }
    if (envelope.success !== true || envelope.operation !== "document.save_as")
      savedFirstSaveEvidenceFail("Original save envelope is not successful");
    firstSavePublication(grant, envelope.result, null);
    evidence.push(reference(stdout));
    return { grant, identity, job, reply: envelope.result, evidence };
  }

  function readSavedPublication(root: string, epoch: SavedEpoch) {
    const file = path.join(epoch.root, "saved-first-save-publication.json"),
      value = readJson(file, 32 * 1024 * 1024) as PublicationRecord;
    if (
      value.version !== 1 ||
      value.kind !== "owner-verified-new-saved-publication" ||
      value.epochId !== epoch.epochId ||
      value.ownerClientId !== epoch.ownerClientId ||
      value.ownerTokenHash !== epoch.ownerTokenHash ||
      !same(value.originDocument, epoch.document) ||
      value.publication?.status !== "complete" ||
      value.publication.grantIssued !== false ||
      !Array.isArray(value.firstSaveEvidence) ||
      !Array.isArray(value.observationEvidence)
    )
      savedFirstSaveEvidenceFail("Exact owner publication record required");
    for (const ref of [
      ...value.firstSaveEvidence,
      ...value.observationEvidence,
      value.observationReceipt,
    ]) {
      if (
        !ref ||
        !path.isAbsolute(ref.path) ||
        fs.realpathSync(ref.path) !== ref.path ||
        fileHash(ref.path).sha256 !== ref.sha256
      )
        savedFirstSaveEvidenceFail("Saved publication evidence changed");
    }
    const first = firstSaveEvidence(root, epoch, value.firstSaveJobId);
    const firstRefs = new Map(
      value.firstSaveEvidence.map((ref) => [ref.path, ref.sha256]),
    );
    if (
      firstRefs.size !== value.firstSaveEvidence.length ||
      firstRefs.size !== first.evidence.length ||
      first.evidence.some((ref) => firstRefs.get(ref.path) !== ref.sha256) ||
      value.sourceCommit !== first.identity.sourceCommit ||
      value.buildHash !== first.identity.buildHash
    )
      savedFirstSaveEvidenceFail(
        "Saved publication must retain all exact first-save evidence and source identity",
      );
    if (
      !same(
        value.publication,
        firstSavePublication(
          first.grant,
          first.reply,
          value.publication.observation,
        ),
      )
    )
      savedFirstSaveEvidenceFail(
        "Saved publication facts differ from the original first save",
      );
    const { proof, binding } = savedAdministrativeEvidence(
      root,
      epoch,
      value.observationReceipt,
      value.observationEvidence,
      {
        prefix: "sp-",
        purpose: "saved-first-save-publication-v1",
        proofName: "sdk-publication.json",
        jobId: first.job.id,
        sourceCommit: first.identity.sourceCommit,
        buildHash: first.identity.buildHash,
      },
    );
    if (
      binding.firstSaveJobId !== first.job.id ||
      !same(binding.destination, {
        projectId: first.reply.target.projectId,
        folderId: first.grant.savedFirstSave.destination.folderId,
      }) ||
      binding.expectedFileId !==
        (first.reply.targetObserved ? first.reply.current.fileId : null) ||
      !same(proof.observed, value.publication.observation)
    )
      savedFirstSaveEvidenceFail(
        "Publication must bind the exact original first-save target",
      );
    return { value, reference: reference(file), first };
  }

  function savedFirstSaveFail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }
  const markerFile = (epoch: SavedEpoch) =>
    path.join(epoch.root, "saved-first-save-scope.json");

  function grantSavedFirstSave(
    p: SavedPorts,
    message: SavedMessage,
    clientId: string,
  ) {
    const keys = [
      "action",
      "auth",
      "control",
      "epochId",
      "grantClientId",
      "requestId",
      "saveRequestId",
      "authorityFile",
      "folderProofFile",
    ];
    if (
      !message ||
      Object.keys(message).some((key) => !keys.includes(key)) ||
      message.action !== "grant-saved-first-save" ||
      ![message.requestId, message.saveRequestId].every(
        (value) =>
          typeof value === "string" && value.trim() && value.length <= 180,
      )
    )
      savedFirstSaveFail(
        "INVALID_REQUEST",
        "Exact stable grant and first-save request IDs required",
      );
    const epoch = p.state.epoch,
      clients = p.clients();
    if (
      !epoch ||
      clientId !== epoch.ownerClientId ||
      clients[clientId] !== epoch.ownerTokenHash
    )
      savedFirstSaveFail(
        "NOT_OWNER",
        "Only the original credential-bound owner may approve a first save",
      );
    p.state.assertEpoch();
    p.assertControl(message.control);
    p.fence();
    if (
      fs.existsSync(
        path.join(
          epochControlDirectory(p.dir, epoch),
          "isolated-scratch-close",
          "intent.json",
        ),
      )
    )
      savedFirstSaveFail(
        "EPOCH_CLEANUP_PENDING",
        "Cleanup intent forbids new save authority",
      );
    if (
      message.epochId !== epoch.epochId ||
      typeof message.grantClientId !== "string" ||
      message.grantClientId === clientId ||
      !/^[a-f0-9]{64}$/.test(clients[message.grantClientId] || "")
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_CLIENT_REQUIRED",
        "Exact fresh epoch and separate registered client required",
      );
    if (
      epoch.kind !== "isolated-fresh-scratch-epoch" ||
      epoch.document.fileId !== null
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_FRESH_REQUIRED",
        "Existing saved or recovered documents cannot be adopted",
      );
    const identity = readJson(
      path.join(epoch.root, "instance.json"),
    ) as SourceIdentity;
    if (
      identity.buildHash !== p.buildHash ||
      p.buildHash !== buildHash() ||
      !/^[a-f0-9]{40}$/.test(identity.sourceCommit || "")
    )
      savedFirstSaveFail(
        "BUILD_CHANGED",
        "First-save scope requires this exact qualified source/runtime",
      );
    const destination = savedDestinationApproval(
      message.authorityFile,
      message.folderProofFile,
      clientId,
    );
    const nativeDestination = readSavedNativeDestination(
      p.dir,
      epoch,
      destination,
    );
    const grant: FirstSaveGrant = {
      epochId: epoch.epochId,
      clientId: message.grantClientId,
      clientTokenHash: clients[message.grantClientId]!,
      document: epoch.document,
      savedFirstSave: {
        version: 1,
        kind: "one-new-first-save-v1",
        requestId: message.requestId,
        saveRequestId: message.saveRequestId,
        sourceCommit: identity.sourceCommit,
        buildHash: p.buildHash,
        destination,
        nativeDestination,
      },
    };
    const file = path.join(
      epoch.root,
      "access-" + hash(grant.clientId + "\0" + grant.clientTokenHash) + ".json",
    );
    if (fs.existsSync(file)) {
      if (!same(readJson(file), grant))
        savedFirstSaveFail(
          "GRANT_SCOPE_CONFLICT",
          "Never broaden an existing client grant",
        );
      if (
        !fs.existsSync(markerFile(epoch)) ||
        !same(readJson(markerFile(epoch)), grant)
      )
        savedFirstSaveFail(
          "SAVED_FIRST_SAVE_SCOPE_INVALID",
          "Exact durable first-save marker required",
        );
      return grant;
    }
    const jobs = Object.values(p.state.data.jobs);
    if (
      jobs.some(
        (job) =>
          job.state !== "succeeded" ||
          job.details?.sdkSettled !== true ||
          job.kind !== "command" ||
          job.request?.payload?.kind !== "cad" ||
          !["document.status", "snapshot"].includes(
            job.request.payload.operation,
          ) ||
          job.request.payload.doc !== epoch.document.name ||
          job.request.payload.docId !== epoch.document.creationId ||
          job.sequenceId ||
          !((job.dispatch?.rpcCount ?? 0) > 0) ||
          job.dispatch!.completedCount !== job.dispatch!.rpcCount,
      ) ||
      p.state.data.active ||
      p.state.data.blocked ||
      p.state.data.lease ||
      p.state.data.localUnknown ||
      p.state.data.controlBlocked ||
      fs.existsSync(path.join(epoch.root, "closed.json"))
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_FRESH_REQUIRED",
        "Only settled readiness reads may precede first-save scope",
      );
    const creation = readJson(epoch.qualificationReceipt.path) as {
      status: string;
      summary?: {
        independent: boolean;
        empty: boolean;
        unsaved: boolean;
        document: SavedDocument;
      };
    };
    if (
      creation.status !== "complete" ||
      creation.summary?.independent !== true ||
      creation.summary.empty !== true ||
      creation.summary.unsaved !== true ||
      !same(creation.summary.document, epoch.document)
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_FRESH_REQUIRED",
        "Independent empty unsaved creation proof required",
      );
    // Publish the narrowing marker first. A lost reply or interrupted grant write
    // must not reopen ordinary modeling. Repeating an identical grant never saves.
    if (fs.existsSync(markerFile(epoch))) {
      if (!same(readJson(markerFile(epoch)), grant))
        savedFirstSaveFail(
          "GRANT_SCOPE_CONFLICT",
          "First-save authority is already pinned",
        );
    } else exclusive(markerFile(epoch), grant);
    exclusive(file, grant);
    return grant;
  }

  function firstSaveAdmission(
    epoch: SavedEpoch,
    request: SavedRequest,
    grant: FirstSaveGrant,
    identity: SourceIdentity,
  ) {
    const scope = grant?.savedFirstSave;
    if (
      !scope ||
      scope.version !== 1 ||
      scope.kind !== "one-new-first-save-v1" ||
      scope.sourceCommit !== identity.sourceCommit ||
      scope.buildHash !== identity.buildHash ||
      !same(grant.document, epoch.document) ||
      grant.epochId !== epoch.epochId ||
      !fs.existsSync(markerFile(epoch)) ||
      !same(readJson(markerFile(epoch)), grant)
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_SCOPE_INVALID",
        "Exact original first-save scope/source/build required",
      );
    const authority = scope.destination?.evidence?.[0],
      proof = scope.destination?.evidence?.[1];
    if (
      !authority ||
      !proof ||
      !same(
        scope.destination,
        savedDestinationApproval(
          authority.path,
          proof.path,
          epoch.ownerClientId,
        ),
      )
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_SCOPE_INVALID",
        "Original owner destination evidence changed",
      );
    if (
      !same(
        scope.nativeDestination,
        readSavedNativeDestination(
          path.dirname(path.dirname(epoch.root)),
          epoch,
          scope.destination,
        ),
      )
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_SCOPE_INVALID",
        "Native destination identity changed",
      );
    const service = host;
    let payload;
    try {
      payload = service.decodeInvocation(request.payload);
    } catch {
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_SCOPE_REQUIRED",
        "Typed first-save invocation required",
      );
    }
    const expected = {
      name: epoch.document.name,
      project: scope.destination.projectName,
      folder: scope.destination.folderName,
      expectedProjectId: scope.nativeDestination.nativeProjectId,
      expectedFolderId: scope.destination.folderId,
      confirm: true,
    };
    if (
      request.kind !== "command" ||
      request.clientId !== grant.clientId ||
      request.requestId !== scope.saveRequestId ||
      request.phased ||
      request.sequenceId ||
      request.inputFiles?.length ||
      payload.kind !== "cad" ||
      payload.operation !== "document.save_as" ||
      payload.doc !== epoch.document.name ||
      payload.docId !== epoch.document.creationId ||
      (payload.docFileId ?? null) !== null ||
      (payload.projectId ?? null) !== null ||
      payload.output !== undefined ||
      !same(payload.data, expected) ||
      !same(request.argv, service.policyArguments(payload))
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_SCOPE_REQUIRED",
        "Only one exact first save of the proven-new document to its approved folder is admitted",
      );
    return {
      kind: "saved-first-save",
      purpose: "saved-fixture-first-save-v1",
      requiresFreshUnmodified: true,
    };
  }

  function firstSavePhase(
    epoch: SavedEpoch | null | undefined,
    jobs: Record<string, SavedJob>,
  ) {
    if (!epoch || !fs.existsSync(markerFile(epoch))) return null;
    const grant = readJson(markerFile(epoch)) as FirstSaveGrant;
    if (
      grant.epochId !== epoch.epochId ||
      !same(grant.document, epoch.document) ||
      grant.savedFirstSave?.kind !== "one-new-first-save-v1"
    )
      savedFirstSaveFail(
        "SAVED_FIRST_SAVE_SCOPE_INVALID",
        "Malformed first-save phase metadata",
      );
    return Object.values(jobs).some(
      (job) =>
        job.clientId === grant.clientId &&
        job.requestId === grant.savedFirstSave.saveRequestId,
    )
      ? "saved-publication-or-retention-only"
      : "qualified-first-save-only";
  }

  function savedFixtureControlFail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }

  function createSavedFixtureControl(p: SavedPorts) {
    const controllers = new Map<string, AuditController>();
    function owner(clientId: string) {
      const epoch = p.state.epoch;
      if (
        !epoch ||
        clientId !== epoch.ownerClientId ||
        p.clients()[clientId] !== epoch.ownerTokenHash
      )
        savedFixtureControlFail(
          "NOT_OWNER",
          "Only the original credential-bound owner may observe or retain a first-saved fixture",
        );
      return epoch;
    }
    function controller(
      phase: "probe" | "observe" | "retain",
      requestId: string,
    ) {
      const kind = savedAuditKind(
        phase === "probe" ? "dp-" : phase === "observe" ? "sp-" : "sr-",
        requestId,
      );
      if (controllers.has(kind)) return controllers.get(kind)!;
      const value = createRecoveryAudit({
        ...p.auditPorts,
        kind,
        priorObservationRequired: false,
        extraKeys:
          phase === "probe"
            ? ["epochId", "authorityFile", "folderProofFile"]
            : ["epochId"],
        jobDirectory: () => epochControlDirectory(p.dir, p.state.epoch),
        prepareReader: prepareSavedFixtureReader,
        parseSummary: parseSavedFixtureReader,
        assertOwner(jobId, _priorObservationId, clientId) {
          const epoch = owner(clientId);
          if (phase === "probe") savedReadinessEvidence(p.dir, epoch, jobId);
          else firstSaveEvidence(p.dir, epoch, jobId);
        },
        async inspect(message, clientId) {
          const epoch = owner(clientId);
          p.state.assertEpoch();
          p.assertControl(message.control);
          p.fence(false);
          if (phase === "probe") {
            savedReadinessEvidence(p.dir, epoch, message.jobId);
            const destination = savedDestinationApproval(
              message.authorityFile,
              message.folderProofFile,
              clientId,
            );
            const identity = readJson(
              path.join(epoch.root, "instance.json"),
            ) as SourceIdentity;
            return {
              identity: epoch.document,
              instance: epoch.currentInstance,
              binding: {
                purpose: "saved-fixture-destination-v1",
                epochId: epoch.epochId,
                document: epoch.document,
                currentInstance: epoch.currentInstance,
                historicalInstance: epoch.originalInstance,
                clientId,
                ownerTokenHash: epoch.ownerTokenHash,
                readinessJobId: message.jobId,
                sourceCommit: identity.sourceCommit,
                buildHash: identity.buildHash,
                destination,
                before: p.snapshot(),
                sdkProofPath: path.join(
                  epochControlDirectory(p.dir, epoch),
                  kind,
                  "sdk-destination.json",
                ),
              },
            };
          }
          const first = firstSaveEvidence(p.dir, epoch, message.jobId);
          const publication =
            phase === "retain" ? readSavedPublication(p.dir, epoch) : null;
          const directory = path.join(
            epochControlDirectory(p.dir, epoch),
            kind,
          );
          return {
            identity: epoch.document,
            instance: epoch.currentInstance,
            binding: {
              purpose:
                phase === "observe"
                  ? "saved-first-save-publication-v1"
                  : "saved-fixture-retain-v1",
              epochId: epoch.epochId,
              document: epoch.document,
              currentInstance: epoch.currentInstance,
              historicalInstance: epoch.originalInstance,
              clientId,
              ownerTokenHash: epoch.ownerTokenHash,
              firstSaveJobId: first.job.id,
              sourceCommit: first.identity.sourceCommit,
              buildHash: first.identity.buildHash,
              before: p.snapshot(),
              sdkProofPath: path.join(
                directory,
                phase === "observe"
                  ? "sdk-publication.json"
                  : "sdk-retained.json",
              ),
              ...(phase === "observe"
                ? {
                    destination: {
                      projectId: first.reply.target.projectId,
                      folderId: first.grant.savedFirstSave.destination.folderId,
                    },
                    expectedFileId: first.reply.targetObserved
                      ? first.reply.current.fileId
                      : null,
                  }
                : {
                    publication: publication!.reference,
                    savedDocument: publication!.value.publication.document,
                    restoreActiveCreationId:
                      epoch.restoreActiveCreationId ?? null,
                  }),
            },
          };
        },
        fence(value, inFlight) {
          owner(value.binding.clientId);
          p.state.assertEpoch();
          if (digest(p.snapshot()) !== digest(value.binding.before))
            savedFixtureControlFail(
              "SAVED_FIXTURE_FENCE_CHANGED",
              "Original first-save owner/runtime/state changed during observation or retain",
            );
          p.fence(inFlight);
        },
        async publishComplete(result, prior, receipt) {
          const epoch = owner(result.clientId);
          const evidence = verifyScratchSdkProof(
            result,
            prior,
            receipt,
            p.auditPorts,
          );
          if (phase === "probe") {
            const ready = savedReadinessEvidence(p.dir, epoch, result.jobId);
            const identity = readJson(
              path.join(epoch.root, "instance.json"),
            ) as SourceIdentity;
            const record = {
              version: 1,
              kind: "owner-verified-native-saved-destination",
              epochId: epoch.epochId,
              originDocument: epoch.document,
              ownerClientId: epoch.ownerClientId,
              ownerTokenHash: epoch.ownerTokenHash,
              sourceCommit: identity.sourceCommit,
              buildHash: identity.buildHash,
              approvedDestination: prior.binding.destination,
              destination: result.summary.destination,
              readinessJobId: ready.job.id,
              readinessJobs: ready.jobs,
              readinessEvidence: ready.evidence,
              receipt: reference(receipt),
              qualificationEvidence: evidence,
            };
            const file = path.join(epoch.root, "saved-destination-native.json");
            if (fs.existsSync(file)) {
              if (!same(readJson(file), record))
                savedFixtureControlFail(
                  "SAVED_DESTINATION_CONFLICT",
                  "A different native destination is already recorded",
                );
            } else {
              this.fence({ binding: prior.binding }, false);
              durable(file, record, true);
            }
            return {
              destination: readSavedNativeDestination(
                p.dir,
                epoch,
                prior.binding.destination as Destination,
              ),
              grantIssued: false,
            };
          }
          const first = firstSaveEvidence(p.dir, epoch, result.jobId);
          if (phase === "observe") {
            const publication = firstSavePublication(
              first.grant,
              first.reply,
              result.summary.observed,
            );
            if (publication.status !== "complete")
              return { publication: publication.status, grantIssued: false };
            const file = path.join(
              epoch.root,
              "saved-first-save-publication.json",
            );
            const record = {
              version: 1,
              kind: "owner-verified-new-saved-publication",
              epochId: epoch.epochId,
              originDocument: epoch.document,
              ownerClientId: epoch.ownerClientId,
              ownerTokenHash: epoch.ownerTokenHash,
              sourceCommit: first.identity.sourceCommit,
              buildHash: first.identity.buildHash,
              firstSaveJobId: first.job.id,
              publication,
              firstSaveEvidence: first.evidence,
              observationReceipt: reference(receipt),
              observationEvidence: evidence,
            };
            if (fs.existsSync(file)) {
              if (!same(readJson(file), record))
                savedFixtureControlFail(
                  "SAVED_PUBLICATION_CONFLICT",
                  "A different publication is already recorded",
                );
            } else {
              this.fence({ binding: prior.binding }, false);
              durable(file, record, true);
            }
            readSavedPublication(p.dir, epoch);
            return {
              publication: "complete",
              record: reference(file),
              grantIssued: false,
            };
          }
          const publication = readSavedPublication(p.dir, epoch);
          if (
            !same(prior.binding.publication, publication.reference) ||
            !same(
              result.summary.savedDocument,
              publication.value.publication.document,
            )
          )
            savedFixtureControlFail(
              "SAVED_RETAIN_SCOPE_CHANGED",
              "Only the exact separately observed publication may be retained",
            );
          const file = path.join(epoch.root, "closed.json");
          const closed = {
            epochId: epoch.epochId,
            document: epoch.document,
            historicalOutcome: "unknown",
            disposition: "retained-new-saved-file",
            retentionRequestId: result.requestId,
            savedDocument: result.summary.savedDocument,
            publication: publication.reference,
            receipt: reference(receipt),
            qualificationEvidence: evidence,
          };
          if (fs.existsSync(file)) {
            if (!same(readJson(file), closed))
              savedFixtureControlFail(
                "SAVED_RETAIN_SCOPE_CHANGED",
                "Retained-file disposition changed",
              );
          } else {
            this.fence({ binding: prior.binding }, false);
            durable(file, closed, true);
          }
          p.closed(epoch);
          return {
            disposition: "retained-new-saved-file",
            activeDocumentRestored: true,
            savedModelingGrantIssued: false,
          };
        },
      });
      controllers.set(kind, value);
      return value;
    }
    function handle(
      phase: "probe" | "observe" | "retain",
      message: SavedMessage,
      clientId: string,
    ) {
      const epoch = owner(clientId);
      const action =
        phase === "probe"
          ? "probe-saved-destination"
          : phase === "observe"
            ? "observe-saved-first-save"
            : "retain-saved-fixture";
      const keys = [
        "action",
        "auth",
        "control",
        "epochId",
        "jobId",
        "requestId",
        ...(phase === "probe" ? ["authorityFile", "folderProofFile"] : []),
      ];
      if (
        message.action !== action ||
        Object.keys(message).some((key) => !keys.includes(key)) ||
        message.epochId !== epoch.epochId ||
        typeof message.requestId !== "string" ||
        !message.requestId.trim() ||
        message.requestId.length > 180
      )
        savedFixtureControlFail(
          "INVALID_REQUEST",
          "Exact saved fixture action/epoch and stable request ID required",
        );
      const prefix =
        phase === "probe" ? "dp-" : phase === "observe" ? "sp-" : "sr-";
      const legacyKind = savedAuditLegacyKind(prefix, message.requestId);
      const legacyDir = path.join(
        epochControlDirectory(p.dir, epoch),
        legacyKind,
      );
      if (fs.existsSync(path.join(legacyDir, "intent.json"))) {
        const prior = readJson(
          path.join(legacyDir, "intent.json"),
        ) as IntentRecord;
        const key = {
          jobId: message.jobId,
          requestId: message.requestId,
          clientId,
        };
        if (
          !same(prior.key, key) ||
          prior.binding?.epochId !== epoch.epochId ||
          prior.binding.ownerTokenHash !== epoch.ownerTokenHash ||
          !same(prior.binding.document, epoch.document)
        )
          savedFixtureControlFail(
            "AUDIT_ALREADY_REQUESTED",
            "An original legacy audit exists; never redirect it to a new SDK attempt",
          );
        const file = path.join(legacyDir, "result.json");
        if (!fs.existsSync(file))
          return {
            kind: legacyKind,
            ...key,
            status: "pending",
            receipt: file,
            legacyRecord: true,
          };
        const original = readJson(file) as AdminResult;
        if (
          original.kind !== legacyKind ||
          Object.entries(key).some(([name, value]) => original[name] !== value)
        )
          savedFixtureControlFail(
            "AUDIT_RESULT_CHANGED",
            "Original legacy audit receipt changed",
          );
        return { ...original, receipt: file, legacyRecord: true };
      }
      if (
        phase === "probe" &&
        fs.existsSync(path.join(epoch.root, "saved-destination-native.json"))
      ) {
        const approved = savedDestinationApproval(
          message.authorityFile,
          message.folderProofFile,
          clientId,
        );
        const destination = readSavedNativeDestination(p.dir, epoch, approved);
        if (
          (readJson(destination.record.path) as NativeDestinationRecord)
            .readinessJobId !== message.jobId
        )
          savedFixtureControlFail(
            "INVALID_REQUEST",
            "Original readiness job required",
          );
        return {
          kind: "saved-native-destination-record",
          status: "complete",
          alreadyRecorded: true,
          destination,
          sdkRequestsSent: 0,
          grantIssued: false,
        };
      }
      if (
        phase === "observe" &&
        fs.existsSync(
          path.join(epoch.root, "saved-first-save-publication.json"),
        )
      ) {
        const published = readSavedPublication(p.dir, epoch);
        if (message.jobId !== published.value.firstSaveJobId)
          savedFixtureControlFail(
            "INVALID_REQUEST",
            "Original first-save job required",
          );
        return {
          kind: "saved-publication-record",
          alreadyRecorded: true,
          status: "complete",
          publication: published.value.publication,
          record: published.reference,
          sdkRequestsSent: 0,
          grantIssued: false,
        };
      }
      if (
        phase === "retain" &&
        !fs.existsSync(
          path.join(epoch.root, "saved-first-save-publication.json"),
        )
      )
        savedFixtureControlFail(
          "SAVED_PUBLICATION_PENDING",
          "A separately observed complete publication is required before retaining/closing",
        );
      if (phase === "retain") {
        const publication = readSavedPublication(p.dir, epoch);
        const file = path.join(epoch.root, "saved-retention-intent.json");
        const intent = {
          version: 1,
          epochId: epoch.epochId,
          ownerClientId: clientId,
          ownerTokenHash: epoch.ownerTokenHash,
          requestId: message.requestId,
          jobId: message.jobId,
          publication: publication.reference,
        };
        if (message.jobId !== publication.value.firstSaveJobId)
          savedFixtureControlFail(
            "INVALID_REQUEST",
            "Original first-save job required",
          );
        if (fs.existsSync(file)) {
          if (!same(readJson(file), intent))
            savedFixtureControlFail(
              "SAVED_RETAIN_ALREADY_REQUESTED",
              "Never repeat retention/close under another request after an uncertain result",
            );
        } else {
          p.state.assertEpoch();
          p.assertControl(message.control);
          p.fence(false);
          durable(file, intent, true);
        }
      }
      return controller(phase, message.requestId).handle(message, clientId);
    }
    return {
      probe: (message: SavedMessage, clientId: string) =>
        handle("probe", message, clientId),
      observe: (message: SavedMessage, clientId: string) =>
        handle("observe", message, clientId),
      retain: (message: SavedMessage, clientId: string) =>
        handle("retain", message, clientId),
    };
  }

  async function savedFixtureAction(
    client: { call(action: string, values?: unknown): Promise<unknown> },
    action: string,
    options: Record<string, unknown>,
    codeHash: string,
  ) {
    if (
      ![
        "probe-saved-destination",
        "grant-saved-first-save",
        "observe-saved-first-save",
        "retain-saved-fixture",
      ].includes(action)
    )
      savedFixtureControlFail(
        "INVALID_REQUEST",
        "Unknown saved fixture action",
      );
    const status = (await client.call("queue-summary")) as {
      features?: { savedFirstSaveLifecycle?: boolean };
      control?: {
        buildHash: string;
        instanceId: string;
        generation: number;
        contextEpoch: number;
      };
    };
    if (status.features?.savedFirstSaveLifecycle !== true)
      savedFixtureControlFail(
        "SAVED_FIXTURE_UNSUPPORTED",
        "Installed broker has no qualified saved first-save lifecycle",
      );
    if (status.control?.buildHash !== codeHash)
      savedFixtureControlFail(
        "BUILD_CHANGED",
        "Saved fixture CLI and broker must share the same qualified runtime",
      );
    const { instanceId, generation, contextEpoch } = status.control;
    return client.call(action, {
      ...options,
      control: { instanceId, generation, contextEpoch, buildHash: codeHash },
    });
  }

  function savedNativeDestinationFail(message: string): never {
    throw Object.assign(new Error(message), {
      code: "SAVED_NATIVE_DESTINATION_REQUIRED",
    });
  }

  function readSavedNativeDestination(
    root: string,
    epoch: SavedEpoch,
    approved: Destination,
  ): NativeDestination {
    const file = path.join(epoch.root, "saved-destination-native.json");
    if (!fs.existsSync(file))
      savedNativeDestinationFail(
        "A separate owner-verified native destination read is required before first-save authority",
      );
    const value = readJson(file, 32 * 1024 * 1024) as NativeDestinationRecord;
    const identity = readJson(
      path.join(epoch.root, "instance.json"),
    ) as SourceIdentity;
    if (
      value.version !== 1 ||
      value.kind !== "owner-verified-native-saved-destination" ||
      value.epochId !== epoch.epochId ||
      value.ownerClientId !== epoch.ownerClientId ||
      value.ownerTokenHash !== epoch.ownerTokenHash ||
      !same(value.originDocument, epoch.document) ||
      !same(value.approvedDestination, approved) ||
      value.sourceCommit !== identity.sourceCommit ||
      value.buildHash !== identity.buildHash ||
      !Array.isArray(value.readinessEvidence)
    )
      savedNativeDestinationFail(
        "Exact owner-approved native destination record required",
      );
    const ready = savedReadinessEvidence(
      root,
      epoch,
      value.readinessJobId,
      value.readinessJobs,
    );
    const refs = new Map(
      value.readinessEvidence.map((ref) => [ref.path, ref.sha256]),
    );
    if (
      refs.size !== value.readinessEvidence.length ||
      refs.size !== ready.evidence.length ||
      ready.evidence.some((ref) => refs.get(ref.path) !== ref.sha256)
    )
      savedNativeDestinationFail(
        "Native destination must preserve original readiness evidence",
      );
    const admin = savedAdministrativeEvidence(
      root,
      epoch,
      value.receipt,
      value.qualificationEvidence,
      {
        prefix: "dp-",
        purpose: "saved-fixture-destination-v1",
        proofName: "sdk-destination.json",
        jobId: ready.job.id,
        sourceCommit: identity.sourceCommit,
        buildHash: identity.buildHash,
      },
    );
    if (
      !same(admin.binding.destination, approved) ||
      admin.binding.readinessJobId !== ready.job.id ||
      !same(value.destination, admin.proof.destination)
    )
      savedNativeDestinationFail(
        "Native destination differs from its exact SDK read",
      );
    return {
      ...value.destination,
      record: { path: file, sha256: fileHash(file).sha256 },
    };
  }

  function savedReadinessEvidenceFail(message: string): never {
    throw Object.assign(new Error(message), {
      code: "SAVED_READINESS_EVIDENCE_REQUIRED",
    });
  }

  function savedReadinessEvidence(
    root: string,
    epoch: SavedEpoch,
    jobId: string,
    recordedJobs?: Record<string, SavedJob>,
  ) {
    const state = readJson(
      path.join(epoch.root, "queue-state.json"),
      256 * 1024 * 1024,
    ) as SavedQueueState;
    const jobs = recordedJobs || state.jobs;
    const values = Object.values(jobs);
    if (
      !values.length ||
      values.some(
        (job) =>
          job.clientId !== epoch.ownerClientId ||
          job.request?.ownerToken !== epoch.ownerTokenHash ||
          job.request.payload?.kind !== "cad" ||
          !["document.status", "snapshot"].includes(
            job.request.payload.operation,
          ) ||
          !same(state.jobs[job.id], job),
      )
    )
      savedReadinessEvidenceFail(
        "Only the original settled owner readiness set may anchor destination discovery",
      );
    const job = jobs[jobId];
    if (!job || job.request.payload.operation !== "document.status")
      savedReadinessEvidenceFail(
        "An actual owner document.status readiness job required",
      );
    const evidence = settledEpochEvidence(root, { jobs }, epoch);
    const stdout = host.responsePath(root, job, "stdout.txt");
    if (fs.statSync(stdout).size > 1024 * 1024)
      savedReadinessEvidenceFail("Bounded readiness output required");
    let envelope: {
      success: boolean;
      operation: string;
      result: FirstSaveReply & ObservedDocument;
    };
    try {
      envelope = JSON.parse(fs.readFileSync(stdout, "utf8"));
    } catch {
      savedReadinessEvidenceFail("Typed original readiness output required");
    }
    const observed = envelope.result;
    if (
      envelope.success !== true ||
      envelope.operation !== "document.status" ||
      observed?.creationId !== epoch.document.creationId ||
      observed.name !== epoch.document.name ||
      observed.saved !== false ||
      observed.modified !== false ||
      observed.fileId !== null
    )
      savedReadinessEvidenceFail(
        "Original independent empty unsaved readiness observation required",
      );
    evidence.push({ path: stdout, sha256: fileHash(stdout).sha256 });
    return { job, jobs, evidence };
  }

  return {
    savedAdministrativeEvidence,
    savedDestinationApproval,
    firstSaveEvidence,
    readSavedPublication,
    reference,
    grantSavedFirstSave,
    firstSaveAdmission,
    firstSavePublication,
    firstSavePhase,
    markerFile,
    createSavedFixtureControl,
    savedFixtureAction,
    readSavedNativeDestination,
    savedReadinessEvidence,
  };
}
