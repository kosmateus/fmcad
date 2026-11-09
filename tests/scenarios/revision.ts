import fs from "node:fs";
import path from "node:path";
import type { Document, Owner, SavedFile } from "./contracts";
import { record } from "./contracts";
import { emit, guard, program } from "./programs";
import * as savedPrograms from "./saved-programs";
import {
  fileProof,
  poll,
  resultValue,
  SavedEvidenceError,
  type Dispatch,
  type RequestEvidence,
} from "./saved-files";

export function revisionProgram(
  document: Document,
  owner: Owner,
  requestId: string,
  receipt: string,
): string {
  if (!document.file) throw new Error("Revision requires an owned saved file");
  return program(`${guard(document)}
assert file.isComplete and not file.isReadOnly
identity = dict(creationId=doc.creationId, name=doc.name, fileId=file.id, previousVersion=file.versionNumber, projectId=file.parentProject.id, folderId=file.parentFolder.id, modified=doc.isModified, clientId=${JSON.stringify(owner.clientId)}, requestId=${JSON.stringify(requestId)})
with open(${JSON.stringify(receipt)}, 'x', encoding='utf-8') as stream:
    _ = stream.write(json.dumps(identity))
assert doc.save('fmcad owned scenario revision'), 'Revision save was refused'
${emit("dict(identity, accepted=True)")}`);
}

function expectedRevision(
  document: Document,
  owner: Owner,
  entries: readonly RequestEvidence[],
  directory: string,
): SavedFile | undefined {
  const saves = entries.filter((r) => r.phase === "revision-save");
  if (!saves.length) return undefined;
  if (saves.length !== 1 || !document.file)
    throw new SavedEvidenceError("Invalid revision request inventory");
  const entry = saves[0]!;
  const value = resultValue(entry);
  if (!value) {
    if (
      entry.result?.sdkSettled &&
      entry.result.state === "failed" &&
      entry.result.mayHaveMutated === false
    )
      return undefined;
    throw new SavedEvidenceError(
      "Original revision acceptance is unavailable; never repeat save",
    );
  }
  const file = document.file;
  if (
    value["accepted"] !== true ||
    value["creationId"] !== document.creationId ||
    value["name"] !== document.name ||
    value["fileId"] !== file.fileId ||
    value["previousVersion"] !== file.version ||
    value["projectId"] !== file.projectId ||
    value["folderId"] !== file.folderId ||
    value["clientId"] !== owner.clientId ||
    value["requestId"] !== entry.requestId ||
    typeof value["modified"] !== "boolean"
  )
    throw new SavedEvidenceError("Foreign original revision receipt");
  const filename = path.join(directory, "revision.json");
  if (
    !fs.existsSync(filename) ||
    !fs.lstatSync(filename).isFile() ||
    fs.lstatSync(filename).isSymbolicLink()
  )
    throw new SavedEvidenceError("Missing regular durable revision intent");
  const durable = record(
    JSON.parse(fs.readFileSync(filename, "utf8")) as unknown,
  );
  const { accepted: _accepted, ...identity } = value;
  void _accepted;
  if (
    Object.keys(durable).length !== Object.keys(identity).length ||
    Object.entries(identity).some(
      ([key, expected]) => durable[key] !== expected,
    )
  )
    throw new SavedEvidenceError(
      "Durable and original revision identities differ",
    );
  return Object.freeze({
    ...file,
    version: file.version + (value["modified"] ? 1 : 0),
  });
}

export async function recoverRevision(
  document: Document,
  owner: Owner,
  entries: readonly RequestEvidence[],
  directory: string,
  dispatch: Dispatch,
): Promise<Document> {
  const expected = expectedRevision(document, owner, entries, directory);
  if (!expected) return document;
  const original = document.file!;
  const observe = (value: Record<string, unknown>): SavedFile | undefined => {
    const file = fileProof(value, document, original);
    if (
      file.fileId !== original.fileId ||
      ![original.version, expected.version].includes(file.version)
    )
      throw new SavedEvidenceError(
        "Revision observation changed the owned file or version",
      );
    return value["complete"] === true && file.version === expected.version
      ? file
      : undefined;
  };
  let completed: SavedFile | undefined;
  const saveIndex = entries.findIndex(
    (entry) => entry.phase === "revision-save",
  );
  for (const [index, entry] of entries.entries()) {
    if (entry.phase !== "revision-observe") continue;
    if (index <= saveIndex)
      throw new SavedEvidenceError("Revision observation preceded save intent");
    const value = resultValue(entry);
    if (value) {
      const file = observe(value);
      if (completed && !file)
        throw new SavedEvidenceError("Completed revision regressed");
      completed = file;
    }
  }
  if (!completed) {
    if (entries.some((entry) => entry.phase.startsWith("reopen-")))
      throw new SavedEvidenceError(
        "Reopen preceded completed revision evidence",
      );
    completed = await poll(
      async () => {
        const value = await dispatch(
          "revision-observe",
          savedPrograms.observeSave(document, original),
          document,
        );
        return observe(value);
      },
      { timeoutMs: 120_000, intervalMs: 50 },
    );
  }
  return Object.freeze({ ...document, file: completed });
}
