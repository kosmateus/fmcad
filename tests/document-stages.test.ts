import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { StageEvidencePort } from "../packages/core/src/application/stage-journal";
import type {
  SaveRecord,
  SaveJournal,
  SaveServices,
} from "../packages/core/src/application/documents/save";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { canonical } = load(
  "./src/dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const { createDocumentSaveStages } = load(
  "./src/document-stages",
) as typeof import("../src/composition/document-stages");
const { execute, bindingFor } = load(
  "./src/dist/core/application/documents/save",
) as typeof import("../packages/core/src/application/documents/save");
test("document stages bind authenticated job scope and original receipt without mutation replay", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "document-stages-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = {
    requestId: "save",
    operationId: "save-op",
    projectId: "project",
    fileId: "file",
    creationId: "doc",
    expectedVersion: 1,
    reportPath: directory,
    confirm: true,
  };
  const binding = bindingFor(input),
    pinnedDocument = binding.target;
  const owner = {
    pinnedDocument,
    scope: {
      owner: "authenticated-owner",
      clientId: "client",
      project: "/canonical/project",
      jobId: "job",
      sequence: "none",
      requestId: "job-request",
      requestHash: "job-request-hash",
      build: "build",
      document: canonical(pinnedDocument),
      inputIdentity: "accepted-original",
    },
  };
  let receipt: "unknown" | "completed" = "unknown";
  let saves = 0;
  const evidence: StageEvidencePort = {
    accepted: () => "available",
    receipt: () =>
      receipt === "completed"
        ? { status: receipt, sha256: "a".repeat(64) }
        : { status: receipt },
  };
  const stage = createDocumentSaveStages(directory, owner, evidence);
  const records: SaveRecord[] = [];
  const journal: SaveJournal = {
    load: async () => ({ records, binding }),
    acquireSubmission: async () => async () => {},
    submissionExists: async () => false,
    append: async (_binding, list, result) => {
      list.push({ result });
    },
  };
  const services: SaveServices = {
    stages: stage.stages,
    open: async () => journal,
    now: () => 0,
    sleep: async () => {},
    status: async () => ({
      name: "Part",
      ...pinnedDocument,
      saved: true,
      modified: true,
      isComplete: true,
      isReadOnly: false,
    }),
    save: async () => {
      saves++;
      const observed = stage.inspect();
      assert.equal(observed.stages[0]?.status, "unknown");
      assert.equal(observed.replayAllowed, false);
      assert.equal(records[0]?.result.status, "submit_uncertain");
      throw Error("ack lost");
    },
  };
  const context = {
    doc: "Part",
    docId: "doc",
    docFileId: "file",
    projectId: "project",
  };
  const out = await execute("document.save.once", input, context, services);
  assert.equal(out.status, "unknown", JSON.stringify(out));
  assert.match(out.stageJournalHead ?? "", /^[a-f0-9]{64}$/);
  assert.equal(stage.resumePlan(out.stageJournalHead).nextStage, null);
  await execute("document.save.once", input, context, services);
  assert.equal(saves, 1);
  receipt = "completed";
  const completed = stage.inspect(out.stageJournalHead);
  assert.equal(completed.stages[0]?.status, "completed");
  assert.equal(
    stage.revalidate(stage.resumePlan(out.stageJournalHead)).valid,
    true,
  );
  const foreign = createDocumentSaveStages(
    directory,
    { ...owner, scope: { ...owner.scope, clientId: "foreign" } },
    evidence,
  );
  assert.equal(foreign.inspect().status, "reconciliationRequired");
  assert.throws(
    () =>
      createDocumentSaveStages(
        directory,
        { ...owner, pinnedDocument: { ...pinnedDocument, fileId: "other" } },
        evidence,
      ),
    /Authenticated document stage scope/,
  );
});
