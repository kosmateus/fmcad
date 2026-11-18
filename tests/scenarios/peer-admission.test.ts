import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fixture } from "./test-support";
import type { ScriptRequest } from "./contracts";
import type { ScenarioReport } from "./runner";
import * as programs from "./programs";
import { discoverOwnedUnsavedFixtureProofs } from "./fixture-provenance";

for (const mode of [
  "create",
  "create-ten",
  "churn-ten",
  "close",
  "unproven",
  "unknown",
  "partial-helper",
  "foreign-request",
  "baseline-change",
  "second-change",
  "close-without-proof",
] as const) {
  test(`independent runner inventory admission: ${mode}`, async (t) => {
    const { backend, directory, model } = await fixture(t, "addin");
    const closing = mode === "close" || mode === "close-without-proof";
    if (mode === "baseline-change") {
      const created = await model.execute(
        programs.program(
          "import adsk.core\ndoc = adsk.core.Application.get().documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\ndoc.name = 'UserBaseline'",
        ),
      );
      assert.equal(created.success, true);
    }
    const peerCount = mode === "create-ten" || mode === "churn-ten" ? 10 : 1;
    const children = [
      "writer",
      ...Array.from({ length: peerCount }, (_, i) => "peer-" + i),
    ].map((role) => {
      const cwd = path.join(directory, role);
      fs.mkdirSync(cwd);
      fs.symlinkSync(
        path.resolve(__dirname, "../../../src"),
        path.join(cwd, "src"),
        "dir",
      );
      return fork(path.join(__dirname, "peer-admission-worker.js"), [], {
        cwd,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          PEER_ADMISSION_ROLE: role,
          PEER_ADMISSION_ROOT: directory,
        },
      });
    });
    t.after(() => {
      for (const child of children) child.kill();
    });
    const [writer, peer] = children;
    assert.ok(writer && peer);
    const peers = children.slice(1);
    let ready = 0;
    let earlyClosed = 0;
    let releaseCad: () => void = () => {};
    const peerReady = new Promise<void>((resolve) => {
      releaseCad = resolve;
    });
    let peerClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      peerClosed = resolve;
    });
    let firstCad = true;
    const cadRequestIds: string[] = [];
    const results = children.map(
      (child) =>
        new Promise<ScenarioReport[]>((resolve, reject) => {
          child.once("error", reject);
          child.stderr?.on("data", (data: Buffer) =>
            process.stderr.write(data),
          );
          child.once("exit", (code) => {
            if (code !== 0) reject(new Error("Worker exit " + code));
          });
          child.on(
            "message",
            (message: {
              type: string;
              request?: ScriptRequest;
              reports?: ScenarioReport[];
              error?: string;
            }) => {
              if (message.type === "error") reject(new Error(message.error));
              if (message.type === "peer-ready") {
                ready++;
                if (ready === peerCount) {
                  if (closing) writer.send({ type: "start" });
                  else if (mode === "churn-ten")
                    for (const p of peers.slice(0, 5))
                      p.send({ type: "release" });
                  else releaseCad();
                }
              }
              if (message.type === "mutated") {
                writer.send({ type: "release" });
                for (const p of peers)
                  if (p.connected) p.send({ type: "release" });
              }
              if (message.type === "done") {
                if (
                  mode === "churn-ten" &&
                  peers.slice(0, 5).includes(child) &&
                  ++earlyClosed === 5
                )
                  releaseCad();
                // Release the peer even on RED so the test never leaves a waiting process.
                if (child === writer)
                  for (const p of peers)
                    if (p.connected) p.send({ type: "release" });
                if (child === peer) {
                  if (mode === "close-without-proof") {
                    const filename = path.join(
                      message.reports![0]!.directory,
                      "report.json",
                    );
                    const report = JSON.parse(
                      fs.readFileSync(filename, "utf8"),
                    ) as ScenarioReport;
                    const cleanup = report.requests.find(
                      (entry) => entry.phase === "cleanup",
                    );
                    assert.ok(cleanup?.result);
                    cleanup.result = {
                      ...cleanup.result,
                      state: "unknown",
                      sdkSettled: false,
                    };
                    fs.writeFileSync(filename, JSON.stringify(report));
                    assert.equal(
                      JSON.parse(
                        fs.readFileSync(filename, "utf8"),
                      ).requests.find(
                        (entry: { phase: string }) => entry.phase === "cleanup",
                      ).result.state,
                      "unknown",
                    );
                    assert.equal(
                      discoverOwnedUnsavedFixtureProofs(directory, {
                        ...backend,
                        qualification: "broker",
                        identity: "peer-admission-simulator:v1",
                      }).get(report.document!.creationId)?.state,
                      "unsettled",
                    );
                  }
                  if (closing) releaseCad();
                  peerClosed();
                }
                resolve(message.reports!);
              }
              if (message.request) {
                const request = message.request;
                void (async () => {
                  if (request.helpers) {
                    cadRequestIds.push(request.requestId);
                    if (firstCad) {
                      firstCad = false;
                      for (const p of peers)
                        p.send({ type: closing ? "release" : "start" });
                      await peerReady;
                      if (mode === "unproven") {
                        await backend.execute({
                          owner: request.owner,
                          requestId: "unproven",
                          directory: request.directory,
                          source: programs.program(
                            "import adsk.core\ndoc = adsk.core.Application.get().documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\ndoc.name = 'Unproven'\n",
                          ),
                        });
                      }
                      if (mode === "baseline-change") {
                        await model.execute(
                          programs.program(
                            "import adsk.core\ndoc = next(d for d in adsk.core.Application.get().documents if d.name == 'UserBaseline')\ndoc.name = 'ChangedBaseline'",
                          ),
                        );
                      }
                    } else if (mode === "second-change") {
                      peer.send({ type: "release" });
                      await closed;
                    }
                  }
                  const result = await backend.execute(request);
                  let stdout = result.stdout;
                  if (request.helpers && cadRequestIds.length === 1) {
                    if (mode === "partial-helper")
                      stdout = stdout.replace(
                        '"helperCallsOnly": []',
                        '"helperCallsOnly": [{"operation":"shape.box","status":"completed","effects":"observed"}]',
                      );
                    if (mode === "foreign-request")
                      stdout = stdout.replace(
                        '"requestId": "' + request.requestId + '"',
                        '"requestId": "foreign"',
                      );
                  }
                  child.send({
                    type: "result",
                    execution: {
                      ...result,
                      stdout,
                      ...(request.helpers && mode === "unknown"
                        ? { state: "unknown", sdkSettled: false }
                        : {}),
                      exitCode: result.state === "succeeded" ? 0 : 1,
                      brokerReceipt: {
                        requestId: request.requestId,
                        clientId: request.owner.clientId,
                        jobId: randomUUID(),
                        state: result.state,
                        operationResult: null,
                      },
                    },
                  });
                })().catch(reject);
              }
            },
          );
        }),
    );
    if (closing) peer.send({ type: "start" });
    else writer.send({ type: "start" });
    const [writerReports] = await Promise.all(results);
    const positive = ["create", "create-ten", "churn-ten", "close"].includes(
      mode,
    );
    assert.equal(
      writerReports?.[0]?.status,
      positive ? "passed" : "failed",
      JSON.stringify(writerReports),
    );
    assert.equal(
      cadRequestIds.length,
      positive || mode === "second-change" ? 2 : 1,
    );
    assert.equal(new Set(cadRequestIds).size, cadRequestIds.length);
    if (positive) assert.equal(writerReports?.[0]?.cleanup, "complete");
    if (positive) {
      const cad = writerReports![0]!.requests.filter((entry) =>
        entry.phase.startsWith("cad-"),
      );
      assert.equal(
        cad[0]!.result?.mayHaveMutated,
        true,
        "Preserve the original generic receipt flag",
      );
      assert.match(cad[0]!.result!.stdout, /"helperCallsOnly": \[\]/u);
      assert.match(cad[0]!.result!.stdout, /"mutationStarted": false/u);
      assert.match(cad[1]!.result!.stdout, /"status": "completed"/u);
    }
  });
}
