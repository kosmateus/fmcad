import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const repository = path.resolve(__dirname, "../..");
const load = createRequire(
  path.join(repository, "tests", "queue-cloud-save.test.js"),
);
type QueueInstance = ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { workflowNonterminal, workflowOutputNonterminal } = load(
  "../src/queue-instance",
) as QueueInstance;
const { failedOutcome } = load(
  "../src/outcome",
) as typeof import("../packages/core/src/domain/outcome");
const { cadCommandFailed } = load(
  "../src/dist/core/application/cad/worker-command",
) as typeof import("../packages/core/src/application/cad/worker-command");

interface PendingSave {
  operation?: string;
  accepted: boolean | null;
  pending: boolean;
  status: string;
  targetObserved: boolean;
  current: {
    creationId: string | null;
    saved: boolean;
    modified: boolean;
    isComplete: boolean;
    fileId: string | null;
    fileName: string;
    projectId: string;
    folderId: string;
  };
  target: { name?: string; projectId?: string; folderId?: string };
  completed?: boolean;
  outcome?: string;
  executionOutcome?: string;
}
interface SaveOutput {
  success: boolean;
  operation: string;
  document: string;
  result: PendingSave;
  status?: string;
  error?: string;
}
function pendingSave(): PendingSave {
  return {
    operation: "document.save_as",
    accepted: true,
    pending: true,
    status: "pending",
    targetObserved: true,
    current: {
      creationId: "new-document-id",
      saved: true,
      modified: false,
      isComplete: false,
      fileId: "observed-transitional-file-id",
      fileName: "owned-name",
      projectId: "project-id",
      folderId: "folder-id",
    },
    target: {
      name: "owned-name",
      projectId: "project-id",
      folderId: "folder-id",
    },
  };
}

test("accepted target-observed save awaiting cloud processing is not an unfinished native command", () => {
  const value = pendingSave();
  assert.equal(workflowNonterminal(value), false);
  const { operation, ...result } = value;
  const text =
    "FMCAD_RESULT " + JSON.stringify({ success: true, operation, result });
  assert.equal(
    workflowOutputNonterminal({
      content: [
        { type: "text", text: JSON.stringify({ success: true, stdout: text }) },
      ],
    }),
    false,
  );
});

test("accepted observed document.save_as pending status is a successful operation outcome, not cloud completion", () => {
  const result = pendingSave();
  delete result.operation;
  const output: SaveOutput = {
    success: true,
    operation: "document.save_as",
    document: "owned-name",
    result,
  };
  assert.equal(failedOutcome(output), false);
  assert.equal(cadCommandFailed(output, "document.save_as"), false);

  for (const mutate of [
    (value: SaveOutput) => {
      value.success = false;
    },
    (value: SaveOutput) => {
      value.status = "failed";
    },
    (value: SaveOutput) => {
      value.error = "rejected";
    },
    (value: SaveOutput) => {
      value.result.accepted = false;
    },
    (value: SaveOutput) => {
      value.result.pending = false;
    },
    (value: SaveOutput) => {
      value.result.targetObserved = false;
    },
    (value: SaveOutput) => {
      value.result.current.fileName = "foreign-name";
    },
    (value: SaveOutput) => {
      value.result.target.projectId = "foreign-project";
    },
  ]) {
    const invalid = structuredClone(output);
    mutate(invalid);
    assert.equal(failedOutcome(invalid), true, JSON.stringify(invalid));
  }
});

test("unaccepted/unobserved saves, foreign targets and explicit unknown native outcomes stay fenced", () => {
  for (const mutate of [
    (value: PendingSave) => {
      value.operation = "batch.run";
    },
    (value: PendingSave) => {
      value.accepted = null;
    },
    (value: PendingSave) => {
      value.targetObserved = false;
    },
    (value: PendingSave) => {
      value.current.saved = false;
    },
    (value: PendingSave) => {
      value.current.modified = true;
    },
    (value: PendingSave) => {
      value.current.creationId = null;
    },
    (value: PendingSave) => {
      value.current.fileId = null;
    },
    (value: PendingSave) => {
      value.current.fileName = "another-file";
    },
    (value: PendingSave) => {
      value.current.projectId = "another-project";
    },
    (value: PendingSave) => {
      value.current.folderId = "another-folder";
    },
    (value: PendingSave) => {
      value.target = {};
    },
    (value: PendingSave) => {
      value.completed = false;
    },
    (value: PendingSave) => {
      value.outcome = "unknown";
    },
    (value: PendingSave) => {
      value.executionOutcome = "unknown";
    },
  ]) {
    const value = pendingSave();
    mutate(value);
    assert.equal(workflowNonterminal(value), true, JSON.stringify(value));
  }
});
