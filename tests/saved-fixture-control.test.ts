import type { RecoveryAuditPorts } from "../packages/node-adapters/src/execution/recovery-audit";
import type {
  ControlFixtureFactory,
  FixturePhase,
  FixtureControlPorts,
  FixtureControl,
  ClosedProofTestApi,
} from "./saved-fixture-test-support";
import { at, record, text } from "./integration/offline-cli";
import type { TestContext } from "node:test";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
test.beforeEach((t) => {
  assert.ok("after" in t);
  t.after(
    (load("./tests/fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  );
});
const api = load("./src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { epochControlDirectory } = load(
  "./src/queue-epoch-lineage",
) as typeof import("../src/queue-epoch-lineage");
const { createSavedFixtureControl } = load(
  "./src/queue-saved-fixture-control",
) as { createSavedFixtureControl(ports: FixtureControlPorts): FixtureControl };
const { closedEpochProof } = load(
  "./src/queue-closed-epoch-proof",
) as ClosedProofTestApi;
const { reference } = load("./src/queue-saved-first-save-evidence") as Pick<
  ReturnType<
    typeof import("../src/composition/library-saved-runtime").createSavedRuntime
  >,
  "reference"
>;
const { savedAuditKind, savedAuditLegacyKind } = load(
  "./src/queue-saved-audit-path",
) as typeof import("../packages/node-adapters/src/persistence/saved-audit-path");
const digest = (value: unknown) =>
  (
    load(
      "./src/dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash(value);

// FAKE transport/physical receipts only; source execution is tested separately in Python/checker tests.
function controlFixture(t: TestContext, beforeSave = false) {
  const repo = root;
  const f = (
    load(
      beforeSave
        ? "./tests/fixtures/saved-first-save.cjs"
        : "./tests/fixtures/saved-first-save-evidence.cjs",
    ) as ControlFixtureFactory
  )(t, repo);
  let directory = "",
    busy = false,
    failRetain = false;
  const sends = { probe: 0, observe: 0, retain: 0 };
  const controlRoot = epochControlDirectory(f.dir, f.state.epoch);
  const ports: Pick<
    RecoveryAuditPorts,
    | "installation"
    | "buildHash"
    | "begin"
    | "end"
    | "admit"
    | "check"
    | "match"
    | "remoteReceipt"
    | "post"
    | "sendScript"
  > = {
    installation: repo,
    buildHash: f.identity.buildHash,
    begin() {
      assert.equal(busy, false);
      busy = true;
    },
    end() {
      busy = false;
    },
    admit: (action) => action(),
    check: async () => ({ report: { status: "passed" }, fence() {} }),
    match(response, payload) {
      assert.equal(response["id"], payload.id);
      return response;
    },
    remoteReceipt: (entry) => {
      const receipt = record(api.readJson(entry.receipt));
      return { ...receipt, outcome: text(receipt["outcome"]) };
    },
    async post(payload) {
      assert.ok(directory);
      const intent = record(api.readJson(path.join(directory, "intent.json"))),
        binding = record(intent["binding"]);
      const start = record(api.readJson(path.join(directory, "start.json")));
      const common = {
        version: 1,
        purpose: binding["purpose"],
        epochId: binding["epochId"],
        document: binding["document"],
        bindingHash: digest(binding),
      };
      let summary: Record<string, unknown>;
      if (binding["purpose"] === "saved-fixture-destination-v1") {
        sends.probe++;
        const destination = Object.fromEntries(
          Object.entries(f.nativeDestination).filter(
            ([key]) => key !== "record",
          ),
        );
        summary = { ...common, destination, readOnly: true };
      } else if (binding["purpose"] === "saved-first-save-publication-v1") {
        sends.observe++;
        summary = {
          ...common,
          observed:
            "observed" in f
              ? f.observed
              : assert.fail("Publication requires saved evidence"),
          readOnly: true,
        };
      } else {
        sends.retain++;
        summary = {
          ...common,
          savedDocument: binding["savedDocument"],
          closed: true,
          saved: true,
          retained: true,
          activeBeforeCloseCreationId: at(binding, "document", "creationId"),
          restoredActiveCreationId: binding["restoreActiveCreationId"],
          activeDocumentRestored: true,
        };
      }
      api.durable(text(binding["sdkProofPath"]), summary, true);
      api.durable(
        text(start["receipt"]),
        {
          ...record(start["binding"]),
          terminal: true,
          outcome: "succeeded",
          instance: f.state.epoch.currentInstance,
        },
        true,
      );
      if (failRetain && binding["purpose"] === "saved-fixture-retain-v1")
        throw new Error("FAKE lost retention reply");
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [
            { type: "text", text: "FMCAD_RESULT " + JSON.stringify(summary) },
          ],
        },
      };
    },
    sendScript(scope, script) {
      return scope.post({
        jsonrpc: "2.0",
        id: "fake-owner-call",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: { code: script + '\n\nrun("")\n', persistent: false },
        },
      });
    },
  };
  const control = createSavedFixtureControl({
    dir: f.dir,
    state: f.state,
    clients: () => f.clients,
    assertControl: f.p.assertControl,
    snapshot: () => ({ state: digest(f.state.data) }),
    fence() {},
    auditPorts: ports,
    closed(epoch) {
      if (!f.state.data.paused)
        f.state.pause(true, "FAKE_RETAINED:" + epoch.epochId);
    },
  });
  async function act(
    phase: FixturePhase,
    requestId: string,
    extra: Record<string, unknown> = {},
  ) {
    const prefix =
      phase === "probe" ? "dp-" : phase === "observe" ? "sp-" : "sr-";
    directory = path.join(controlRoot, savedAuditKind(prefix, requestId));
    const message = {
      action:
        phase === "probe"
          ? "probe-saved-destination"
          : phase === "observe"
            ? "observe-saved-first-save"
            : "retain-saved-fixture",
      control: { fake: true },
      epochId: f.state.epoch.epochId,
      jobId:
        phase === "probe"
          ? f.readinessJob.id
          : "job" in f
            ? f.job.id
            : assert.fail(
                "Publication and retention need the first-save evidence fixture",
              ),
      requestId,
      ...extra,
    };
    let result = record(await control[phase](message, f.clientId));
    if (result["status"] === "pending") {
      for (let i = 0; i < 1000 && busy; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(busy, false, "FAKE owner audit did not settle");
      result = record(await control[phase](message, f.clientId)); // Original intent only; never submits another SDK turn.
    }
    return result;
  }
  return {
    ...f,
    control,
    act,
    sends,
    failRetain: () => {
      failRetain = true;
    },
  };
}

test("FAKE owner control records an actual native-ID read before first-save authority", async (t) => {
  const f = controlFixture(t, true);
  fs.unlinkSync(path.join(f.state.epoch.root, "saved-destination-native.json")); // Only this synthetic test's generated record.
  const result = await f.act("probe", "new-native-destination-read", {
    authorityFile: f.message.authorityFile,
    folderProofFile: f.message.folderProofFile,
  });
  assert.equal(result["status"], "complete");
  assert.equal(f.sends.probe, 1);
  assert.equal(at(result, "destination", "nativeProjectId"), "native-project");
  assert.equal(result["grantIssued"], false);
  assert.equal(typeof f.grant, "function");
  assert.ok(typeof f.grant === "function");
  assert.doesNotThrow(f.grant);
});

test("FAKE owner control separately observes publication, retains once and preserves a genuine closed proof", async (t) => {
  const f = controlFixture(t);
  const published = await f.act("observe", "separate-publication-read");
  assert.equal(at(published, "publication", "status"), "complete");
  assert.equal(published["sdkRequestsSent"], 0);
  assert.equal(f.sends.observe, 1);
  const retained = await f.act("retain", "one-retention");
  assert.equal(retained["status"], "complete");
  assert.equal(f.sends.retain, 1);
  assert.equal(f.state.data.paused, true);
  const proof = closedEpochProof(
    f.dir,
    f.state.epoch,
    reference(path.join(f.state.epoch.root, "closed.json")),
  );
  assert.equal(proof.proof["saved"], true);
  assert.equal(proof.proof["retained"], true);
  await f.act("retain", "one-retention");
  assert.equal(f.sends.retain, 1);
  await assert.rejects(f.act("retain", "different-retention"), {
    code: "SAVED_RETAIN_ALREADY_REQUESTED",
  });
});

test("FAKE uncertain retention never gets a second close under another request ID", async (t) => {
  const f = controlFixture(t);
  await f.act("observe", "publication-before-uncertainty");
  f.failRetain();
  const result = await f.act("retain", "uncertain-retention");
  assert.equal(result["status"], "failed");
  assert.equal(f.sends.retain, 1);
  await assert.rejects(f.act("retain", "blind-retry"), {
    code: "SAVED_RETAIN_ALREADY_REQUESTED",
  });
  assert.equal(f.sends.retain, 1);
  assert.equal(
    fs.existsSync(path.join(f.state.epoch.root, "closed.json")),
    false,
  );
});

test("FAKE legacy failed audit is read as original evidence, never reissued into the short layout", async (t) => {
  const f = controlFixture(t, true),
    epoch = f.state.epoch,
    requestId = "old-long-directory-probe";
  const kind = savedAuditLegacyKind("dp-", requestId),
    dir = path.join(epochControlDirectory(f.dir, epoch), kind);
  fs.mkdirSync(dir, { recursive: true });
  const key = { jobId: f.readinessJob.id, requestId, clientId: f.clientId };
  api.durable(
    path.join(dir, "intent.json"),
    {
      key,
      binding: {
        epochId: epoch.epochId,
        ownerTokenHash: epoch.ownerTokenHash,
        document: epoch.document,
      },
    },
    true,
  );
  api.durable(
    path.join(dir, "result.json"),
    {
      kind,
      ...key,
      status: "failed",
      code: "RECEIPT_UNAVAILABLE",
      sdkRequestsSent: 1,
    },
    true,
  );
  const result = await f.act("probe", requestId, {
    authorityFile: f.message.authorityFile,
    folderProofFile: f.message.folderProofFile,
  });
  assert.equal(result["status"], "failed");
  assert.equal(result["code"], "RECEIPT_UNAVAILABLE");
  assert.equal(result["legacyRecord"], true);
  assert.equal(f.sends.probe, 0);
});
