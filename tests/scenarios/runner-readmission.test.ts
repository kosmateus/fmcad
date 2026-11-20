import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { fixture } from "./test-support";
import { runScenarios, type ScenarioSession } from "./runner";
import type { ScenarioBackend, Execution } from "./contracts";
import { record } from "./contracts";
import { cliSettlementTimeoutMs } from "./legacy-handoff";
import { program, emit } from "./programs";

test("captureUserView readmits after a canonical peer closes between prepare and SDK", async (t) => {
  const f = await fixture(t);
  const user = await f.model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Original user'
class Workspace:
    id = 'FusionSolidEnvironment'
    def activate(self):
        app.userInterface.activeWorkspace = self
        return True
class Workspaces:
    def itemById(self, key):
        assert key == 'FusionSolidEnvironment'
        return Workspace()
app.userInterface.activeWorkspace = Workspace()
app.userInterface.workspaces = Workspaces()`),
  );
  assert.equal(user.success, true, user.error);
  let peer!: ScenarioSession;
  let ready!: () => void, release!: () => void;
  const peerReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captures = 0;
  const backend: ScenarioBackend = {
    ...f.backend,
    capabilities: new Set([...f.backend.capabilities, "original-user-view"]),
    async execute(request) {
      if (
        request.owner.scenarioId === "capture-subject" &&
        request.source.includes("view_plan: JsonRecord")
      ) {
        if (captures++ === 0) await peer.cleanup();
      }
      const execution = await f.backend.execute(request);
      const jobId = randomUUID();
      return {
        ...execution,
        brokerReceipt: {
          jobId,
          requestId: request.requestId,
          clientId: request.owner.clientId,
          state: execution.state,
          operationResult: {
            version: 1,
            jobId,
            requestId: request.requestId,
            acceptance: "accepted",
            executionOutcome: execution.state,
            mayHaveMutated: execution.mayHaveMutated,
          },
        },
      };
    },
  };
  const peers = runScenarios(
    backend,
    [
      {
        id: "closing-view-peer",
        requires: [],
        async run(session) {
          peer = session;
          session.expectCleanupModified(false);
          await session.observe(
            "observe-restore-user-focus",
            program(`import adsk.core, json
assert adsk.core.Application.get().documents.item(0).activate()
${emit(`dict(restored=True, creationId=${JSON.stringify(session.document.creationId)})`)}`),
          );
          ready();
          await released;
        },
      },
    ],
    f.directory,
    1,
  );
  try {
    await Promise.race([
      peerReady,
      peers.then((reports) => {
        throw new Error(
          "Peer failed before capture: " + JSON.stringify(reports),
        );
      }),
    ]);
    const reports = await runScenarios(
      backend,
      [
        {
          id: "capture-subject",
          scope: "exclusive-instance",
          requires: ["original-user-view"],
          async run(session) {
            session.expectCleanupModified(false);
          },
        },
      ],
      f.directory,
      1,
    );
    assert.equal(reports[0]!.status, "passed", reports[0]!.error);
    assert.equal(captures, 2);
    const attempts = reports[0]!.requests.filter((entry) =>
      entry.phase.startsWith("original-user-view-capture"),
    );
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]!.requestId, attempts[1]!.requestId);
    assert.match(attempts[0]!.result!.stdout, /"viewAdmissionChanged": true/u);
    assert.doesNotMatch(attempts[0]!.result!.stdout, /FMCAD_VIEW_EFFECT/u);
    assert.equal(reports[0]!.cleanup, "complete");
  } finally {
    release();
    await peers;
  }
});

async function exercise(
  t: TestContext,
  mode:
    | "success"
    | "unknown"
    | "foreign"
    | "mutation"
    | "abort"
    | "deadline"
    | "retained"
    | "retained-no-progress"
    | "retained-existing-receipt"
    | "ordinary-peer-receipt"
    | "retained-rebound-receipt"
    | "no-progress" = "success",
) {
  const f = await fixture(t);
  const peers: ScenarioSession[] = [];
  let allReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    allReady = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  const helperResults: string[] = [];
  const controller = new AbortController();
  let firstAdmission: Execution | undefined;
  const backend: ScenarioBackend = {
    ...f.backend,
    async execute(request) {
      if (
        request.owner.scenarioId === "subject" &&
        request.helpers === "cad-v1"
      ) {
        if (
          turns === 1 &&
          (mode === "retained" ||
            mode === "retained-no-progress" ||
            mode === "retained-existing-receipt" ||
            mode === "ordinary-peer-receipt" ||
            mode === "retained-rebound-receipt")
        ) {
          const peer = peers[1]!;
          if (
            mode !== "retained-existing-receipt" &&
            mode !== "retained-rebound-receipt"
          )
            await peer.observe(
              "observe-terminal-peer",
              program(
                "import json\n" +
                  emit(
                    `{"creationId": ${JSON.stringify(peer.document.creationId)}}`,
                  ),
              ),
            );
          if (mode !== "ordinary-peer-receipt") {
            assert.throws(
              () =>
                peer.deferCleanup(
                  "Retain a fully settled failed peer for inspection",
                ),
              /Retain a fully settled failed peer/u,
            );
            peer.report.status = "failed";
            if (mode === "retained-rebound-receipt") {
              const receipt = record(
                peer.report.requests.at(-1)!.result!.brokerReceipt,
              );
              const jobId = randomUUID();
              receipt["jobId"] = jobId;
              record(receipt["operationResult"])["jobId"] = jobId;
            }
            fs.writeFileSync(
              path.join(peer.directory, "report.json"),
              JSON.stringify(peer.report),
            );
          }
        }
        if (
          (mode === "no-progress" && turns === 1) ||
          ((mode === "retained" ||
            mode === "retained-no-progress" ||
            mode === "retained-existing-receipt" ||
            mode === "ordinary-peer-receipt" ||
            mode === "retained-rebound-receipt") &&
            turns === 1) ||
          (mode === "retained-no-progress" && turns === 2)
        ) {
          assert.ok(firstAdmission);
          turns++;
          const stdout = firstAdmission.stdout.replaceAll(
            firstAdmission.requestId,
            request.requestId,
          );
          helperResults.push(stdout);
          return {
            ...firstAdmission,
            requestId: request.requestId,
            stdout,
            brokerReceipt: {
              requestId: request.requestId,
              clientId: request.owner.clientId,
              jobId: randomUUID(),
              state: "succeeded",
              operationResult: null,
            },
          };
        }
        if (turns < 2) await peers[turns]!.cleanup();
        turns++;
      }
      let result = await f.backend.execute(request);
      if (request.helpers === "cad-v1") {
        if (turns === 1) {
          if (mode === "unknown")
            result = { ...result, state: "unknown", sdkSettled: false };
          if (mode === "mutation")
            result = {
              ...result,
              stdout: result.stdout.replace(
                '"mutationStarted": false',
                '"mutationStarted": true',
              ),
            };
          if (mode === "abort")
            controller.abort(new Error("Original admission aborted"));
          if (mode === "deadline") {
            const expired = Date.now() + cliSettlementTimeoutMs + 1;
            t.mock.method(Date, "now", () => expired);
          }
        }
        helperResults.push(result.stdout);
        if (mode === "retained-no-progress") firstAdmission = result;
        else firstAdmission ??= result;
      }
      const jobId = randomUUID();
      return {
        ...result,
        brokerReceipt: {
          requestId: request.requestId,
          clientId:
            mode === "foreign" && request.helpers === "cad-v1"
              ? "foreign-client"
              : request.owner.clientId,
          jobId,
          state: result.state,
          operationResult: request.owner.scenarioId.startsWith("peer-")
            ? {
                version: 1,
                requestId: request.requestId,
                jobId,
                acceptance: "accepted",
                executionOutcome: "succeeded",
                mayHaveMutated: result.mayHaveMutated,
              }
            : null,
        },
      };
    },
  };
  const peer = (id: string) => ({
    id,
    requires: [],
    async run(session: ScenarioSession) {
      session.expectCleanupModified(false);
      peers.push(session);
      if (peers.length === 2) allReady();
      await released;
    },
  });
  const reports = await runScenarios(
    backend,
    [
      peer("peer-one"),
      peer("peer-two"),
      {
        id: "subject",
        requires: [],
        async run(session) {
          await ready;
          try {
            const value = await session.cadFenced(
              "cad-two-closed-peers",
              "shape.box",
              {
                name: "OwnedOnce",
                width: "10 mm",
                depth: "20 mm",
                height: "30 mm",
              },
            );
            assert.equal(value["success"], true);
            session.expectCleanupModified(true);
          } finally {
            release();
          }
        },
      },
    ],
    f.directory,
    3,
    mode === "abort" ? controller.signal : undefined,
  );
  return { reports, turns, helperResults };
}

test("a repeated no-helper marker without new lifecycle evidence cannot extend the finite readmission budget", async (t) => {
  const { reports, turns } = await exercise(t, "no-progress");
  const subject = reports.find(
    (report) => report.owner.scenarioId === "subject",
  )!;
  assert.equal(subject.status, "failed");
  assert.equal(subject.cleanup, "deferred");
  assert.match(subject.error!, /without new lifecycle evidence/u);
  assert.equal(turns, 2);
});

test("an exact retained peer terminal receipt permits one finite readmission without closing that peer", async (t) => {
  const { reports, turns, helperResults } = await exercise(t, "retained");
  const subject = reports.find(
    (report) => report.owner.scenarioId === "subject",
  )!;
  const peer = reports.find(
    (report) => report.owner.scenarioId === "peer-two",
  )!;
  assert.equal(subject.status, "passed", subject.error);
  assert.equal(subject.cleanup, "complete");
  assert.equal(peer.status, "failed");
  assert.equal(peer.cleanup, "deferred");
  assert.equal(turns, 3);
  assert.deepEqual(
    helperResults.map((stdout) => {
      const line = stdout
        .split(/\r?\n/u)
        .find((row) => row.startsWith("FMCAD_RESULT "))!;
      const output = JSON.parse(line.slice("FMCAD_RESULT ".length)) as {
        helperCallsOnly: unknown[];
      };
      return output.helperCallsOnly.length;
    }),
    [0, 0, 1],
  );
});

test("the same retained peer terminal receipt cannot extend readmission again", async (t) => {
  const { reports, turns } = await exercise(t, "retained-no-progress");
  const subject = reports.find(
    (report) => report.owner.scenarioId === "subject",
  )!;
  assert.equal(subject.status, "failed");
  assert.equal(subject.cleanup, "deferred");
  assert.match(
    subject.error!,
    /without new lifecycle evidence|no new terminal receipt/u,
  );
  assert.equal(turns, 3);
});

test("changing report status with an already observed settled receipt gives no terminal progress", async (t) => {
  const { reports, turns } = await exercise(t, "retained-existing-receipt");
  const subject = reports.find(
    (report) => report.owner.scenarioId === "subject",
  )!;
  assert.equal(subject.status, "failed");
  assert.equal(subject.cleanup, "deferred");
  assert.match(subject.error!, /no new terminal receipt/u);
  assert.equal(turns, 2);
});

test("a new ordinary peer result does not count as new lifecycle evidence", async (t) => {
  const { reports, turns } = await exercise(t, "ordinary-peer-receipt");
  const subject = reports.find(
    (report) => report.owner.scenarioId === "subject",
  )!;
  assert.equal(subject.status, "failed");
  assert.match(subject.error!, /without new lifecycle evidence/u);
  assert.equal(turns, 2);
});

test("terminal peer provenance cannot rebind an observed request to a new job", async (t) => {
  const { reports, turns } = await exercise(t, "retained-rebound-receipt");
  const subject = reports.find(
    (report) => report.owner.scenarioId === "subject",
  )!;
  assert.equal(subject.status, "failed");
  assert.match(subject.error!, /changed its original job identity/u);
  assert.equal(turns, 2);
});

test("two exact peer close receipts between admission turns do not replay a helper", async (t) => {
  const { reports, turns, helperResults } = await exercise(t);
  assert.deepEqual(
    reports.map((report) => ({
      status: report.status,
      cleanup: report.cleanup,
    })),
    Array.from({ length: 3 }, () => ({
      status: "passed",
      cleanup: "complete",
    })),
    JSON.stringify(reports.map((report) => report.error)),
  );
  assert.equal(turns, 3);
  const outputs = helperResults.map(
    (stdout) =>
      JSON.parse(
        stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("FMCAD_RESULT "))!
          .slice("FMCAD_RESULT ".length),
      ) as { helperCallsOnly: unknown[] },
  );
  assert.deepEqual(
    outputs.map((output) => output.helperCallsOnly.length),
    [0, 0, 1],
  );
});

for (const mode of [
  "unknown",
  "foreign",
  "mutation",
  "abort",
  "deadline",
] as const) {
  test(`readmission stops on ${mode} without dispatching another helper turn`, async (t) => {
    const { reports, turns, helperResults } = await exercise(t, mode);
    const subject = reports.find(
      (report) => report.owner.scenarioId === "subject",
    )!;
    assert.equal(subject.status, "failed");
    assert.equal(subject.cleanup, "deferred");
    assert.equal(turns, 1);
    assert.equal(helperResults.length, 1);
    assert.ok(subject.error);
  });
}
