import type {
  FirstSaveGrant,
  FirstSaveReply,
  ObservedDocument,
  Publication,
} from "./saved-fixture-contracts";

export function firstSavePublication(
  grant: FirstSaveGrant,
  reply: FirstSaveReply | null | undefined,
  observed: ObservedDocument | null | undefined,
): Publication {
  const scope = grant?.savedFirstSave,
    destination = scope?.destination,
    origin = grant?.document;
  function invalid(message: string): never {
    throw Object.assign(new Error(message), {
      code: "SAVED_FIRST_SAVE_PUBLICATION_INVALID",
    });
  }
  if (
    !scope ||
    scope.kind !== "one-new-first-save-v1" ||
    !origin ||
    origin.fileId !== null ||
    !destination
  )
    invalid("Original new-document first-save scope required");
  const base = {
    saveRequestId: scope.saveRequestId,
    originDocument: origin,
    grantIssued: false,
    existingDataChangesAllowed: false,
    retention: "keep-for-user-inspection",
  };
  if (!reply || reply.accepted !== true)
    return {
      ...base,
      status: reply?.accepted === false ? "failed" : "unknown",
      firstSave: reply ?? null,
    };
  if (
    !["complete", "pending"].includes(reply.status) ||
    typeof reply.targetObserved !== "boolean" ||
    reply.pending !== (reply.status === "pending") ||
    reply.original?.creationId !== origin.creationId ||
    reply.original?.name !== origin.name ||
    reply.original?.fileId !== null ||
    reply.original?.saved !== false ||
    reply.original?.modified !== false ||
    reply.copyRequested !== false ||
    reply.target?.name !== origin.name ||
    reply.target?.projectName !== destination.projectName ||
    reply.target?.folder !== destination.folderName ||
    reply.target?.folderId !== destination.folderId ||
    reply.target?.projectId !== scope.nativeDestination?.nativeProjectId ||
    typeof reply.target?.projectId !== "string" ||
    !reply.target.projectId
  )
    invalid(
      "First-save receipt must retain exact fresh origin and approved destination",
    );
  if (
    reply.targetObserved === true &&
    (typeof reply.current?.fileId !== "string" ||
      !reply.current.fileId ||
      reply.current.creationId !== origin.creationId ||
      reply.current.projectId !== reply.target.projectId ||
      reply.current.folderId !== destination.folderId ||
      reply.current.fileName !== origin.name)
  )
    invalid("A targetObserved receipt must contain the exact new file lineage");
  if (!observed)
    return {
      ...base,
      status: "accepted",
      firstSave: reply,
      observation: null,
    };
  if (
    observed.creationId !== origin.creationId ||
    observed.name !== origin.name
  )
    invalid("Publication observation belongs to another document");
  if (observed.dataFileError)
    return {
      ...base,
      status: "unknown",
      firstSave: reply,
      observation: observed,
    };
  if (observed.fileId === null && typeof observed.saved === "boolean")
    return {
      ...base,
      status: "pending",
      firstSave: reply,
      observation: observed,
    };
  if (reply.targetObserved === true && observed.fileId !== reply.current.fileId)
    invalid(
      "Publication cannot replace an already observed first-save file lineage",
    );
  if (
    typeof observed.fileId !== "string" ||
    !observed.fileId ||
    observed.saved !== true ||
    (observed.fileName != null && observed.fileName !== origin.name) ||
    (observed.projectId != null &&
      observed.projectId !== reply.target.projectId) ||
    (observed.folderId != null && observed.folderId !== destination.folderId)
  )
    invalid("Observed new file must match exact name/project/folder lineage");
  if (
    observed.fileName !== origin.name ||
    observed.projectId !== reply.target.projectId ||
    observed.folderId !== destination.folderId ||
    observed.isComplete !== true ||
    observed.modified !== false
  )
    return {
      ...base,
      status: "pending",
      firstSave: reply,
      observation: observed,
    };
  if (observed.version !== 1)
    invalid("Unexpected first-published version; never adopt version drift");
  return {
    ...base,
    status: "complete",
    firstSave: reply,
    observation: observed,
    cloudProjectId: destination.cloudProjectId,
    document: {
      name: observed.name,
      creationId: observed.creationId,
      fileId: observed.fileId,
      projectId: observed.projectId,
      folderId: observed.folderId,
      version: observed.version,
    },
  };
}
