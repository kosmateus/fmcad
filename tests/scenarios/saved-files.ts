import * as fs from "node:fs";
import path from "node:path";
import type {
  Document,
  Execution,
  FixtureFolder,
  Owner,
  SavedFile,
} from "./contracts";
import { number, record, text } from "./contracts";
import * as programs from "./programs";
import * as saved from "./saved-programs";

export interface RequestEvidence {
  readonly requestId: string;
  readonly phase: string;
  readonly result?: Execution;
}
export type Dispatch = (
  phase: string,
  source: string | ((requestId: string) => string),
  target?: Document,
  routeTarget?: boolean,
) => Promise<Record<string, unknown>>;

export class UnsettledCloudOperation extends Error {}
export class SavedEvidenceError extends Error {}
export interface CloudPolling {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}
const defaultPolling: CloudPolling = { timeoutMs: 120_000, intervalMs: 50 };

export function resultValue(
  entry: RequestEvidence | undefined,
): Record<string, unknown> | undefined {
  const result = entry?.result;
  if (
    !result ||
    !result.sdkSettled ||
    result.state !== "succeeded" ||
    result.requestId !== entry?.requestId
  )
    return undefined;
  const lines = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(programs.marker));
  if (lines.length !== 1) throw new Error("Invalid original lifecycle result");
  return record(
    JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
  );
}

export function saveIntent(
  directory: string,
  document: Document,
  owner: Owner,
  requests: readonly RequestEvidence[],
): FixtureFolder | undefined {
  const entries = requests.filter((entry) => entry.phase === "save");
  if (!entries.length) return undefined;
  if (entries.length !== 1)
    throw new Error("Fixture save was submitted more than once");
  const entry = entries[0]!;
  const filename = path.join(directory, "save-intent.json");
  if (!fs.existsSync(filename)) {
    if (entry.result?.state === "failed" && entry.result.sdkSettled)
      return undefined;
    throw new Error(
      "Missing original save intent; cleanup must remain deferred",
    );
  }
  if (
    !fs.lstatSync(filename).isFile() ||
    fs.lstatSync(filename).isSymbolicLink()
  )
    throw new Error("Expected a regular owned save intent");
  const value = record(
    JSON.parse(fs.readFileSync(filename, "utf8")) as unknown,
  );
  if (
    value["creationId"] !== document.creationId ||
    value["name"] !== document.name ||
    value["clientId"] !== owner.clientId ||
    value["requestId"] !== entry.requestId
  )
    throw new Error("Save intent does not belong to this original request");
  const folder = Object.freeze({
    projectId: text(value["projectId"]),
    folderId: text(value["folderId"]),
  });
  const original = resultValue(entry);
  if (
    original &&
    (original["accepted"] !== true ||
      Object.entries(value).some(
        ([key, expected]) => original[key] !== expected,
      ))
  )
    throw new Error("Original save acceptance differs from durable intent");
  return folder;
}

export function fileProof(
  value: Record<string, unknown>,
  document: Document,
  folder: FixtureFolder,
): SavedFile {
  if (
    value["creationId"] !== document.creationId ||
    value["projectId"] !== folder.projectId ||
    value["folderId"] !== folder.folderId
  )
    throw new SavedEvidenceError("Foreign saved file proof");
  const version = number(value["version"]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("Invalid exact file version");
  return Object.freeze({ ...folder, fileId: text(value["fileId"]), version });
}

export function recoveredFile(
  document: Document,
  folder: FixtureFolder,
  requests: readonly RequestEvidence[],
): SavedFile | undefined {
  let file: SavedFile | undefined;
  let complete = false;
  for (const entry of requests.filter(
    (entry) => entry.phase === "save-observe",
  )) {
    const value = resultValue(entry);
    if (!value || !value["fileId"]) continue;
    const observed = fileProof(value, document, folder);
    if (
      file &&
      (file.fileId !== observed.fileId || file.version !== observed.version)
    )
      throw new SavedEvidenceError(
        "Saved fixture identity changed between observations",
      );
    file = observed;
    complete = value["complete"] === true;
  }
  return complete ? file : undefined;
}

export async function poll<T>(
  observe: () => Promise<T | undefined>,
  policy: CloudPolling,
): Promise<T> {
  if (
    ![policy.timeoutMs, policy.intervalMs].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    throw new Error("Invalid cloud polling budget");
  const deadline = Date.now() + policy.timeoutMs;
  do {
    const result = await observe();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, policy.intervalMs));
  } while (Date.now() < deadline);
  throw new UnsettledCloudOperation(
    "Original cloud operation is not observed complete; cleanup deferred, never replay",
  );
}

export async function observeSavedFile(
  document: Document,
  folder: FixtureFolder,
  dispatch: Dispatch,
  allowUnsaved: boolean,
  policy: CloudPolling = defaultPolling,
): Promise<SavedFile | null> {
  let pinned: SavedFile | undefined = document.file;
  return poll(async () => {
    const value = await dispatch(
      "save-observe",
      saved.observeSave(document, folder),
      document,
    );
    if (value["saved"] === false && allowUnsaved && !value["fileId"])
      return null;
    if (!value["fileId"]) return undefined;
    const file = fileProof(value, document, folder);
    if (
      pinned &&
      (pinned.fileId !== file.fileId || pinned.version !== file.version)
    )
      throw new SavedEvidenceError(
        "Saved fixture changed during completion observation",
      );
    pinned = file;
    return value["complete"] === true ? file : undefined;
  }, policy);
}

export async function cleanupSavedFile(
  document: Document,
  requests: readonly RequestEvidence[],
  dispatch: Dispatch,
  policy: CloudPolling = defaultPolling,
): Promise<void> {
  if (!document.file) throw new Error("Missing saved fixture ownership");
  const owned = document.file;
  const validate = (value: Record<string, unknown>): void => {
    const file = fileProof(value, document, owned);
    if (file.fileId !== owned.fileId || file.version !== owned.version)
      throw new SavedEvidenceError("Foreign file observation during cleanup");
  };
  const closed = requests.findLast(
    (entry) =>
      entry.phase === "cleanup-close" ||
      (entry.phase === "reopen-close" &&
        resultValue(entry)?.["creationId"] === document.creationId),
  );
  const closeProof = resultValue(closed);
  if (!closeProof) {
    const value = await dispatch(
      "cleanup-close",
      programs.close(document),
      document,
      false,
    );
    if (value["closed"] !== true)
      throw new Error("Owned document closure was not observed");
  } else if (
    closeProof["creationId"] !== document.creationId ||
    closeProof["closed"] !== true
  ) {
    throw new Error("Foreign original close proof");
  }
  const deletion = requests.findLast(
    (entry) => entry.phase === "cleanup-delete",
  );
  const deleted = resultValue(deletion);
  if (deleted) {
    const file = fileProof(deleted, document, document.file);
    if (
      file.fileId !== document.file.fileId ||
      file.version !== document.file.version ||
      deleted["accepted"] !== true
    )
      throw new Error("Foreign original deletion proof");
  } else {
    // A settled failure may have removed the file before failing to publish its result.
    // Establish current absence/identity before deciding whether a new delete is needed.
    const state = await dispatch(
      "cleanup-observe",
      saved.fileOperation(document, false),
      document,
      false,
    );
    validate(state);
    if (state["absent"] === true) return;
    const value = await dispatch(
      "cleanup-delete",
      saved.fileOperation(document, true),
      document,
      false,
    );
    const file = fileProof(value, document, document.file);
    if (
      file.fileId !== document.file.fileId ||
      file.version !== document.file.version ||
      value["accepted"] !== true
    )
      throw new Error("Deletion did not establish the owned file identity");
  }
  await poll(async () => {
    const state = await dispatch(
      "cleanup-observe",
      saved.fileOperation(document, false),
      document,
      false,
    );
    validate(state);
    return state["absent"] === true ? true : undefined;
  }, policy);
}
