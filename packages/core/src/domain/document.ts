/** Parsed command intent, independent of CLI argv, SDK and queue revision. */
export interface DocumentIntent {
  kind: string;
  target?: string | undefined;
  rpcMethod?: string | undefined;
  name?: string | undefined;
  creationId?: string | undefined;
  fileId?: string | undefined;
}
export interface DocumentSelector {
  metadataOnly?: true;
  name?: string;
  creationId?: string;
  fileId?: string;
}
export function selectDocument(
  intent: DocumentIntent,
): DocumentSelector | null {
  if (intent.kind === "rpc") {
    return [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
    ].includes(intent.rpcMethod ?? "")
      ? { metadataOnly: true }
      : null;
  }
  if (
    ["tools", "doctor"].includes(intent.kind) ||
    (intent.kind === "docops" &&
      [
        "docOpenCmd",
        "docSearchCmd",
        "docListCmd",
        "docRecentCmd",
        "activeCmd",
      ].includes(intent.target ?? ""))
  )
    return { metadataOnly: true };
  const selector: DocumentSelector = {};
  for (const key of ["name", "creationId", "fileId"] as const)
    if (intent[key]) selector[key] = intent[key];
  return Object.keys(selector).length ? selector : null;
}
export interface DocumentSnapshot {
  status?: string;
  fingerprint?: string;
  state?: { identity?: { creationId?: string } };
}
/** The fingerprint is document/dependency scoped, never a global queue revision. */
export function compareDocumentState(
  previous?: DocumentSnapshot | null,
  current?: DocumentSnapshot | null,
):
  | "DOCUMENT_STATE_UNAVAILABLE"
  | "DOCUMENT_BASELINE_REQUIRED"
  | "DOCUMENT_TARGET_CHANGED"
  | "DOCUMENT_CHANGED"
  | null {
  if (
    previous?.status === "metadata-only" &&
    current?.status === "metadata-only"
  )
    return null;
  if (current?.status !== "complete") return "DOCUMENT_STATE_UNAVAILABLE";
  if (previous?.status !== "complete") return "DOCUMENT_BASELINE_REQUIRED";
  if (
    previous.state?.identity?.creationId !== current.state?.identity?.creationId
  )
    return "DOCUMENT_TARGET_CHANGED";
  return previous.fingerprint === current.fingerprint
    ? null
    : "DOCUMENT_CHANGED";
}
