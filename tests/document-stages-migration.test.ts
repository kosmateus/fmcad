import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  StageEntry,
  StageEvidencePort,
  StageJournalPort,
} from "../packages/core/src/application/stage-journal";
import type { DocumentSaveStageOwner } from "../packages/core/src/application/documents/stages";
import type {
  SaveJournal,
  SaveRecord,
  SaveRequest,
  SaveServices,
} from "../packages/core/src/application/documents/save";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const core = load(
  "./src/dist/core/application/stage-journal",
) as typeof import("../packages/core/src/application/stage-journal");
const current = load(
  "./src/dist/core/application/documents/stages",
) as typeof import("../packages/core/src/application/documents/stages");
const save = load(
  "./src/dist/core/application/documents/save",
) as typeof import("../packages/core/src/application/documents/save");
const { canonical, clone } = load(
  "./src/dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const storage = load(
  "./src/dist/node-adapters/persistence/stage-journal",
) as typeof import("../packages/node-adapters/src/persistence/stage-journal");
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
type Session = ReturnType<typeof current.createDocumentSaveStages>;
type Version = "introduced" | "typed";

function fixture(t: TestContext, version: Version, loseAppend?: number) {
  const input: SaveRequest = {
    requestId: "save",
    operationId: "save-op",
    projectId: "project",
    fileId: "file-Żółć",
    creationId: "doc-A",
    expectedVersion: 1,
    reportPath: "unused-Żółć",
    confirm: true,
  };
  const binding = save.bindingFor(input);
  const owner: DocumentSaveStageOwner = {
    pinnedDocument: clone(binding.target),
    scope: {
      owner: "owner",
      clientId: "client",
      project: "/project",
      jobId: "job",
      sequence: "none",
      requestId: "request",
      requestHash: "request-hash",
      build: "build",
      document: canonical(binding.target),
      inputIdentity: "accepted-original",
    },
  };
  let records: StageEntry[] = [];
  const journalScope = clone(owner.scope);
  let appends = 0;
  const journal: StageJournalPort = {
    read: () => {
      core.validateStageJournal(records, journalScope);
      return clone(records);
    },
    append(entry) {
      core.validateStageJournal([...records, entry], journalScope);
      appends++;
      records = appends === loseAppend ? [] : [...records, clone(entry)];
    },
  };
  let receipt: "unknown" | "completed" = "unknown";
  const evidence: StageEvidencePort = {
    accepted: () => "available",
    receipt: () =>
      receipt === "completed"
        ? { status: receipt, sha256: "a".repeat(64) }
        : { status: receipt },
  };
  let session: Session;
  if (version === "typed")
    session = current.createDocumentSaveStages(owner, evidence, () => journal);
  else {
    // Only the journal storage is replaced. The retained module runs the real
    // stage validator, API, inspector and SHA-256 receipt encoder.
    const mock = t.mock.method(storage, "openStageJournal", () => journal);
    const old = historical(
      "2bad473b98d29486d4b21a19b0a8253d1914fb6d",
      "src/document-stages.js",
    ) as {
      createDocumentSaveStages(
        directory: string,
        owner: DocumentSaveStageOwner,
        evidence: StageEvidencePort,
      ): Session;
    };
    session = old.createDocumentSaveStages("unused", owner, evidence);
    mock.mock.restore();
  }
  return {
    input,
    binding,
    owner,
    session,
    journal,
    evidence,
    entries: () => clone(records),
    complete: () => {
      receipt = "completed";
    },
  };
}

for (const version of ["introduced", "typed"] as const) {
  test(`${version}: exact receipt bytes, unresolved intent and completed advice`, async (t) => {
    const f = fixture(t, version);
    const head = await f.session.stages.plan(f.binding);
    assert.equal(f.session.resumePlan(head).nextStage, "document.save.once");
    await assert.rejects(
      async () => f.session.stages.plan(f.binding),
      /already exists/,
    );
    const started = await f.session.stages.started(f.binding);
    const intent = f.entries()[1]?.event;
    assert.equal(intent?.kind, "started");
    if (intent?.kind !== "started") throw new Error("Missing intent");
    assert.equal(
      intent.receipt,
      createHash("sha256").update(canonical(f.binding), "utf8").digest("hex"),
    );
    assert.equal(f.session.inspect(started).stages[0]?.status, "unknown");
    assert.equal(f.session.resumePlan(started).nextStage, null);
    assert.equal(f.session.inspect(head).status, "reconciliationRequired");
    const before = f.session.resumePlan(started);
    f.complete();
    assert.equal(f.session.revalidate(before).valid, false);
    const completed = f.session.resumePlan(started);
    assert.equal(completed.stages[0]?.status, "completed");
    assert.equal(completed.nextStage, null);
    assert.equal(completed.replayAllowed, false);
    assert.equal(completed.automaticResume, false);
    assert.equal(f.session.revalidate(completed).valid, true);
  });
  for (const key of ["creationId", "fileId", "projectId", "version"] as const)
    test(`${version}: rejects a foreign ${key} before publishing`, async (t) => {
      const f = fixture(t, version);
      const foreign = clone(f.binding);
      if (key === "version") foreign.target[key]++;
      else foreign.target[key] += "-foreign";
      await assert.rejects(
        async () => f.session.stages.plan(foreign),
        /target differs/,
      );
      assert.deepEqual(f.entries(), []);
    });
  test(`${version}: changed request and repeated intent cannot acquire permission`, async (t) => {
    const f = fixture(t, version);
    await f.session.stages.plan(f.binding);
    const before = f.entries();
    await assert.rejects(
      async () =>
        f.session.stages.started({ ...f.binding, requestHash: "foreign" }),
      /plan differs/,
    );
    assert.deepEqual(f.entries(), before);
    await f.session.stages.started(f.binding);
    await assert.rejects(
      async () => f.session.stages.started(f.binding),
      /repeated stage intent/,
    );
    assert.equal(f.entries().length, 2);
  });
  test(`${version}: a lost save reply remains unknown and never resubmits`, async (t) => {
    const f = fixture(t, version);
    const records: SaveRecord[] = [];
    let submissions = 0;
    const journal: SaveJournal = {
      load: async () => ({ records, binding: f.binding }),
      acquireSubmission: async () => async () => {},
      submissionExists: async () => false,
      append: async (_binding, list, result) => {
        list.push({ result });
      },
    };
    const services: SaveServices = {
      stages: f.session.stages,
      open: async () => journal,
      now: () => 0,
      sleep: async () => {},
      status: async () => ({
        ...f.binding.target,
        name: "Part",
        saved: true,
        modified: true,
        isComplete: true,
        isReadOnly: false,
      }),
      save: async () => {
        submissions++;
        throw new Error("ack lost");
      },
    };
    const context = {
      doc: "Part",
      docId: "doc-A",
      docFileId: "file-Żółć",
      projectId: "project",
    };
    const first = await save.execute(
      "document.save.once",
      f.input,
      context,
      services,
    );
    assert.equal(first.status, "unknown");
    assert.match(first.stageJournalHead ?? "", /^[a-f0-9]{64}$/);
    const second = await save.execute(
      "document.save.once",
      f.input,
      context,
      services,
    );
    assert.equal(second.status, "unknown");
    assert.equal(second.replayedReceipt, true);
    assert.equal(submissions, 1);
  });
}

test("typed stages retain byte-identical plans and intents", async (t) => {
  const snapshots: StageEntry[][] = [];
  for (const version of ["introduced", "typed"] as const) {
    const f = fixture(t, version);
    await f.session.stages.plan(f.binding);
    await f.session.stages.started(f.binding);
    snapshots.push(f.entries());
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
});

for (const loseAppend of [1, 2])
  test(`missing journal after append ${loseAppend} blocks the physical save`, async (t) => {
    for (const version of ["introduced", "typed"] as const) {
      const f = fixture(t, version, loseAppend);
      const records: SaveRecord[] = [];
      let submissions = 0;
      const result = await save.execute(
        "document.save.once",
        f.input,
        {
          doc: "Part",
          docId: "doc-A",
          docFileId: "file-Żółć",
          projectId: "project",
        },
        {
          stages: f.session.stages,
          now: () => 0,
          sleep: async () => {},
          open: async () => ({
            load: async () => ({ records, binding: f.binding }),
            acquireSubmission: async () => async () => {},
            submissionExists: async () => false,
            append: async (_binding, list, evidence) => {
              list.push({ result: evidence });
            },
          }),
          status: async () => ({
            ...f.binding.target,
            name: "Part",
            saved: true,
            modified: true,
            isComplete: true,
            isReadOnly: false,
          }),
          save: async () => {
            submissions++;
            throw new Error("ack lost");
          },
        },
      );
      const unsafe = version === "introduced" && loseAppend === 2;
      assert.equal(submissions, unsafe ? 1 : 0);
      assert.equal(result.status, unsafe ? "unknown" : "blocked");
      if (version === "typed")
        assert.match(
          result.unavailableEvidence?.join(" ") ?? "",
          /journal disappeared/,
        );
      assert.equal(f.session.inspect().status, "missing");
    }
  });

test("invalid owner scope rejects before opening storage", (t) => {
  const f = fixture(t, "typed");
  const owner = clone(f.owner);
  owner.pinnedDocument.fileId = "foreign";
  let opened = false;
  assert.throws(
    () =>
      current.createDocumentSaveStages(owner, f.evidence, () => {
        opened = true;
        return f.journal;
      }),
    /Authenticated document stage scope/,
  );
  assert.equal(opened, false);
});
