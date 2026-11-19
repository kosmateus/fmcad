import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support";
import { runScenarios, type ScenarioSession } from "./runner";
import type { ScenarioBackend, Execution } from "./contracts";
import { cliSettlementTimeoutMs } from "./legacy-handoff";

async function exercise(
  t: TestContext,
  mode:
    | "success"
    | "unknown"
    | "foreign"
    | "mutation"
    | "abort"
    | "deadline"
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
        if (mode === "no-progress" && turns === 1) {
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
        firstAdmission ??= result;
      }
      return {
        ...result,
        brokerReceipt: {
          requestId: request.requestId,
          clientId:
            mode === "foreign" && request.helpers === "cad-v1"
              ? "foreign-client"
              : request.owner.clientId,
          jobId: randomUUID(),
          state: result.state,
          operationResult: null,
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
