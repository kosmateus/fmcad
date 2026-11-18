import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Document, Execution, Owner } from "./contracts";
import { record, text } from "./contracts";
import { marker } from "./programs";

/** A same-document save bridge, not proof of cloud completion or closure. */
export interface SavedIdentityTransition {
  readonly version: 1;
  readonly originalCreationId: string;
  readonly saveRequestId: string;
  readonly creationId: string;
  readonly name: string;
}

function read(directory: string, name: string): Record<string, unknown> {
  const fd = fs.openSync(
    path.join(directory, name),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= 1024 * 1024);
    return record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown);
  } finally {
    fs.closeSync(fd);
  }
}

export function savedIdentityTransition(
  directory: string,
  original: Document,
  owner: Owner,
  requests: readonly {
    readonly requestId: string;
    readonly phase: string;
    readonly result?: Execution;
  }[],
): SavedIdentityTransition | undefined {
  const saves = requests.filter((entry) => entry.phase === "save");
  if (!saves.length) return undefined;
  assert.equal(saves.length, 1, "First save must never be replayed");
  const entry = saves[0]!,
    execution = entry.result;
  const filename = path.join(directory, "save-transition.json");
  if (!fs.existsSync(filename)) return undefined;
  assert.ok(execution?.sdkSettled && execution.state === "succeeded");
  assert.equal(execution.requestId, entry.requestId);
  const receipt = execution.brokerReceipt;
  assert.ok(receipt, "Save transition lacks its original broker receipt");
  assert.equal(receipt.requestId, entry.requestId);
  assert.equal(receipt.clientId, owner.clientId);
  assert.equal(receipt.state, "succeeded");
  text(receipt.jobId);
  const suffix = entry.requestId.slice(owner.clientId.length + 1);
  assert.equal(entry.requestId, owner.clientId + ":" + suffix);
  assert.match(suffix, /^[1-9][0-9]*$/u);
  const creation = read(directory, "creation.json");
  assert.equal(original.file, undefined);
  assert.equal(creation["creationId"], original.creationId);
  assert.equal(creation["name"], original.name);
  assert.equal(creation["clientId"], owner.clientId);
  assert.equal(creation["requestId"], owner.clientId + ":0");
  const intent = read(directory, "save-intent.json");
  assert.equal(intent["creationId"], original.creationId);
  assert.equal(intent["name"], original.name);
  assert.equal(intent["clientId"], owner.clientId);
  assert.equal(intent["requestId"], entry.requestId);
  text(intent["projectId"]);
  text(intent["folderId"]);
  const lines = execution.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(marker));
  assert.equal(lines.length, 1, "Expected one original save acceptance");
  const returned = record(
    JSON.parse(text(lines[0]).slice(marker.length)) as unknown,
  );
  const durable = read(directory, "save-transition.json");
  assert.deepEqual(
    durable,
    returned,
    "Durable and returned save bridge differ",
  );
  for (const [key, value] of Object.entries(intent))
    assert.equal(
      returned[key],
      value,
      "Save bridge differs from original intent",
    );
  assert.equal(returned["accepted"], true);
  assert.equal(
    returned["postReadbackError"],
    undefined,
    "Post-save identity is unavailable; never replay save",
  );
  return Object.freeze({
    version: 1,
    originalCreationId: original.creationId,
    saveRequestId: entry.requestId,
    creationId: text(returned["postCreationId"]),
    name: text(returned["postName"]),
  });
}
