import fs from "node:fs";
import path from "node:path";
import type { Document, Owner } from "./contracts";
import { record, text } from "./contracts";
import { emit, program } from "./programs";
import {
  resultValue,
  SavedEvidenceError,
  type RequestEvidence,
} from "./saved-files";

export function reopenProgram(
  document: Document,
  owner: Owner,
  requestId: string,
  receipt: string,
): string {
  const file = document.file;
  if (!file) throw new Error("Reopen requires an exact saved fixture");
  const q = JSON.stringify;
  return program(`import adsk.core, json
from typing import cast
app = adsk.core.Application.get()
assert not any(d.creationId == ${q(document.creationId)} for d in app.documents), 'Original fixture is still open'
assert not any(d.dataFile is not None and d.dataFile.id == ${q(file.fileId)} for d in app.documents), 'Fixture file already has an open document'
file = cast('adsk.core.DataFile | None', app.data.findFileById(${q(file.fileId)}))
assert file is not None and file.id == ${q(file.fileId)}
assert file.name == ${q(document.name)} and file.isComplete and not file.isReadOnly
assert file.versionNumber == ${file.version} and file.latestVersionNumber == ${file.version}, 'Reopen version changed'
assert file.parentProject.id == ${q(file.projectId)} and file.parentFolder.id == ${q(file.folderId)}
doc = app.documents.open(file, True)
assert doc is not None and doc.isSaved and doc.name == ${q(document.name)}
opened_file = cast('adsk.core.DataFile | None', doc.dataFile)
assert opened_file is not None and opened_file.id == file.id and opened_file.versionNumber == file.versionNumber
assert doc.creationId != ${q(document.creationId)}, 'Reopen did not establish a new document identity'
identity = dict(creationId=doc.creationId, previousCreationId=${q(document.creationId)}, name=doc.name, fileId=file.id, version=file.versionNumber, projectId=file.parentProject.id, folderId=file.parentFolder.id, clientId=${q(owner.clientId)}, requestId=${q(requestId)})
with open(${q(receipt)}, 'x', encoding='utf-8') as stream:
    _ = stream.write(json.dumps(identity))
${emit("identity")}`);
}

export function reopenProof(
  value: Record<string, unknown>,
  original: Document,
  owner: Owner,
  requestId: string,
): Document {
  const file = original.file;
  if (
    !file ||
    value["previousCreationId"] !== original.creationId ||
    value["name"] !== original.name ||
    value["clientId"] !== owner.clientId ||
    value["requestId"] !== requestId ||
    value["fileId"] !== file.fileId ||
    value["version"] !== file.version ||
    value["projectId"] !== file.projectId ||
    value["folderId"] !== file.folderId ||
    value["creationId"] === original.creationId
  )
    throw new SavedEvidenceError(
      "Reopen receipt does not belong to the original saved fixture",
    );
  return Object.freeze({
    name: original.name,
    creationId: text(value["creationId"]),
    file,
  });
}

/** Derive identity only from original backend evidence, never editable report fields. */
export function recoveredReopen(
  original: Document,
  owner: Owner,
  requests: readonly RequestEvidence[],
  directory: string,
): Document {
  const closes = requests.filter((entry) => entry.phase === "reopen-close");
  const opens = requests.filter((entry) => entry.phase === "reopen-open");
  if (closes.length > 1 || opens.length > 1 || (opens.length && !closes.length))
    throw new SavedEvidenceError(
      "Invalid reopen request sequence; mutation replay is forbidden",
    );
  if (!closes.length) return original;
  const closed = resultValue(closes[0]);
  if (!closed) {
    if (opens.length || closes[0]?.result?.mayHaveMutated !== false)
      throw new SavedEvidenceError(
        "Original reopen close lacks settlement proof",
      );
    return original;
  }
  if (closed["creationId"] !== original.creationId || closed["closed"] !== true)
    throw new SavedEvidenceError("Foreign reopen close proof");
  if (!opens.length) return original;
  if (requests.indexOf(opens[0]!) <= requests.indexOf(closes[0]!))
    throw new SavedEvidenceError("Reopen preceded its original close");
  const value = resultValue(opens[0]);
  if (!value) {
    if (opens[0]?.result?.mayHaveMutated !== false)
      throw new SavedEvidenceError("Original reopen lacks settlement proof");
    return original;
  }
  const opened = reopenProof(value, original, owner, opens[0]!.requestId);
  const filename = path.join(directory, "reopen.json");
  if (
    !fs.existsSync(filename) ||
    !fs.lstatSync(filename).isFile() ||
    fs.lstatSync(filename).isSymbolicLink()
  )
    throw new SavedEvidenceError("Missing regular durable reopen receipt");
  const durable = reopenProof(
    record(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown),
    original,
    owner,
    opens[0]!.requestId,
  );
  if (durable.creationId !== opened.creationId)
    throw new SavedEvidenceError(
      "Original and durable reopened identities differ",
    );
  return opened;
}
