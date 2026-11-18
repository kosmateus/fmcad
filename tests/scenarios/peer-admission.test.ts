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
  "saved-same",
  "saved-changed",
  "saved-initial",
  "saved-close",
  "saved-transition",
  "saved-transition-same",
  "saved-restore-missing",
  "saved-restore-unsettled",
  "saved-restore-user",
  "initial-create",
  "initial-close",
  "refresh-create",
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
    const transitioning =
      mode === "saved-transition" ||
      mode === "saved-transition-same" ||
      mode.startsWith("saved-restore-");
    if (mode === "saved-changed" || mode === "saved-transition") {
      const configured = await model.execute(
        programs.program(`import adsk.core
original_save = adsk.core.Document.saveAs
def changed_save(self, name, folder, description, tag):
    result = original_save(self, name, folder, description, tag)
    self.creationId = self.creationId + '-saved'
    self.name = self.name + ' v1'
    return result
adsk.core.Document.saveAs = changed_save`),
      );
      assert.equal(configured.success, true, configured.error);
    }
    const closing =
      mode === "close" ||
      mode === "close-without-proof" ||
      mode === "initial-close" ||
      mode === "saved-close";
    if (
      mode === "baseline-change" ||
      mode === "initial-close" ||
      mode === "saved-restore-user"
    ) {
      const created = await model.execute(
        programs.program(
          "import adsk.core\ndoc = adsk.core.Application.get().documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\ndoc.name = 'UserBaseline'",
        ),
      );
      assert.equal(created.success, true);
    }
    const peerCount =
      mode === "create-ten" || mode === "churn-ten"
        ? 10
        : mode === "refresh-create"
          ? 2
          : 1;
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
          PEER_ADMISSION_SAVED: mode.startsWith("saved-") ? "1" : "0",
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
    let releaseSave: () => void = () => {};
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let laterPeerReady: () => void = () => {};
    const laterReady = new Promise<void>((resolve) => {
      laterPeerReady = resolve;
    });
    const cadRequestIds: string[] = [];
    const restoreRequestIds: string[] = [];
    let peerReport: ScenarioReport | undefined;
    const releasedChildren = new Set<(typeof children)[number]>();
    const completedChildren = new Set<(typeof children)[number]>();
    const releaseChild = (child: (typeof children)[number]) => {
      if (releasedChildren.has(child) || completedChildren.has(child)) return;
      releasedChildren.add(child);
      child.send({ type: "release" }, (error) => {
        if (error) child.emit("error", error);
      });
    };
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
                if (mode === "refresh-create") {
                  if (ready === 1) releaseCad();
                  if (ready === 2) laterPeerReady();
                }
                if (ready === peerCount) {
                  if (closing || mode === "saved-initial") {
                    if (mode === "saved-initial") releaseCad();
                    writer.send({ type: "start" });
                  } else if (mode === "churn-ten")
                    for (const p of peers.slice(0, 5)) releaseChild(p);
                  else releaseCad();
                }
              }
              if (message.type === "mutated") {
                releaseChild(writer);
                for (const p of peers) releaseChild(p);
              }
              if (message.type === "done") {
                completedChildren.add(child);
                if (
                  mode === "churn-ten" &&
                  peers.slice(0, 5).includes(child) &&
                  ++earlyClosed === 5
                )
                  releaseCad();
                // Release the peer even on RED so the test never leaves a waiting process.
                if (child === writer) for (const p of peers) releaseChild(p);
                if (child === peer) {
                  peerReport = message.reports![0]!;
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
                if (
                  child === writer &&
                  request.requestId.endsWith(":coordinator:restore")
                )
                  restoreRequestIds.push(request.requestId);
                void (async () => {
                  if (
                    transitioning &&
                    child === peer &&
                    request.source.includes("assert doc.saveAs")
                  ) {
                    writer.send({ type: "start" });
                    await saveReleased;
                  }
                  if (request.helpers) {
                    cadRequestIds.push(request.requestId);
                    if (firstCad) {
                      firstCad = false;
                      if (transitioning) releaseSave();
                      if (
                        mode !== "initial-create" &&
                        mode !== "initial-close" &&
                        mode !== "saved-initial" &&
                        !transitioning
                      )
                        for (const p of mode === "refresh-create"
                          ? peers.slice(0, 1)
                          : peers)
                          if (closing) releaseChild(p);
                          else p.send({ type: "start" });
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
                      releaseChild(peer);
                      await closed;
                    }
                  }
                  if (
                    (mode === "initial-close" ||
                      mode === "saved-restore-user") &&
                    child === writer &&
                    request.requestId.endsWith(":coordinator:before")
                  ) {
                    await model.execute(
                      programs.program(
                        "import adsk.core\nnext(d for d in adsk.core.Application.get().documents if d.name == 'UserBaseline').activate()",
                      ),
                    );
                  }
                  const result = await backend.execute(request);
                  if (
                    (mode === "saved-restore-missing" ||
                      mode === "saved-restore-unsettled") &&
                    child === writer &&
                    request.requestId.endsWith(":coordinator:after")
                  ) {
                    await closed;
                    assert.ok(peerReport);
                    const filename = path.join(
                      peerReport.directory,
                      "report.json",
                    );
                    const report = JSON.parse(
                      fs.readFileSync(filename, "utf8"),
                    );
                    if (mode === "saved-restore-missing")
                      delete report.savedIdentityTransition;
                    else report.cleanupHold = "Unsettled saved owner";
                    fs.writeFileSync(filename, JSON.stringify(report));
                  }
                  if (
                    mode === "initial-close" &&
                    child === writer &&
                    request.requestId.endsWith(":coordinator:before")
                  ) {
                    releaseChild(peer);
                    await closed;
                  }
                  if (
                    mode === "refresh-create" &&
                    child === writer &&
                    request.helpers &&
                    cadRequestIds.length === 1
                  ) {
                    peers[1]!.send({ type: "start" });
                    await laterReady;
                  }
                  if (
                    mode === "initial-create" &&
                    child === writer &&
                    request.requestId.endsWith(":coordinator:before")
                  ) {
                    peer.send({ type: "start" });
                    await peerReady;
                  }
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
    if (closing || mode === "saved-initial" || transitioning)
      peer.send({ type: "start" });
    else writer.send({ type: "start" });
    const [writerReports] = await Promise.all(results);
    const positive = [
      "saved-restore-user",
      "create",
      "saved-same",
      "saved-changed",
      "saved-initial",
      "saved-close",
      "saved-transition",
      "saved-transition-same",
      "initial-create",
      "initial-close",
      "refresh-create",
      "create-ten",
      "churn-ten",
      "close",
    ].includes(mode);
    assert.equal(
      writerReports?.[0]?.status,
      positive ? "passed" : "failed",
      JSON.stringify(writerReports),
    );
    assert.equal(
      cadRequestIds.length,
      (positive &&
        mode !== "initial-create" &&
        mode !== "initial-close" &&
        mode !== "saved-initial") ||
        mode === "second-change" ||
        mode === "saved-restore-missing" ||
        mode === "saved-restore-unsettled"
        ? 2
        : 1,
    );
    assert.equal(new Set(cadRequestIds).size, cadRequestIds.length);
    if (positive) assert.equal(writerReports?.[0]?.cleanup, "complete");
    if (mode === "saved-restore-user")
      assert.equal(restoreRequestIds.length, 1);
    if (mode === "saved-transition" || mode === "saved-transition-same")
      assert.equal(restoreRequestIds.length, 0);
    if (
      positive &&
      mode !== "initial-create" &&
      mode !== "initial-close" &&
      mode !== "saved-initial"
    ) {
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
