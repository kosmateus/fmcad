import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "./runner";
import { record, text } from "./contracts";
import { program, emit } from "./programs";
import { concurrencyLimit } from "./scheduling";
import { assertFencedClosedDocumentInventory } from "./fixture-provenance";
import { resultValue } from "./saved-files";

export const nativeLegacyCapability = "native-legacy-cli-effects";
export function nativeLegacyScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-legacy-" + index,
    scope: "exclusive-instance",
    requires: ["documents", "owned-child-cli", nativeLegacyCapability],
    async run(session) {
      const own = session.document;
      assert.equal(
        own.file,
        undefined,
        "Legacy local commands require an unsaved owned fixture",
      );
      try {
        await session.legacyScript("tests/scenarios/legacy-owned-driver.ts");
      } finally {
        await session.cleanup();
        if (session.report.cleanup === "complete") {
          const cleanup = session.report.requests.findLast(
              (request) => request.phase === "cleanup",
            ),
            close = resultValue(cleanup);
          assert.ok(
            close,
            "Legacy cleanup requires its settled original close receipt",
          );
          const receipt = record(cleanup?.result?.brokerReceipt);
          assert.equal(receipt["requestId"], cleanup?.requestId);
          assert.equal(receipt["clientId"], session.report.owner.clientId);
          assert.equal(receipt["state"], "succeeded");
          text(receipt["jobId"]);
          assert.equal(close["creationId"], own.creationId);
          assert.equal(close["closed"], true);
          const fence = record(close["inventoryFence"]);
          assert.equal(fence["version"], 1);
          assertFencedClosedDocumentInventory(
            fence["before"],
            fence["after"],
            own,
            "Legacy cleanup changed a non-target document during the close SDK turn",
          );
          const after = await session.observe(
            "observe-legacy-after-cleanup",
            program(`import adsk.core, json
app = adsk.core.Application.get()
assert not any(d.creationId == ${JSON.stringify(own.creationId)} for d in app.documents)
documents = [dict(name=d.name, creationId=d.creationId, fileId=d.dataFile.id if d.dataFile else None, modified=d.isModified, saved=d.isSaved, active=d == app.activeDocument) for d in app.documents]
${emit(`dict(creationId=${JSON.stringify(own.creationId)}, documents=documents, active=app.activeDocument.name if app.activeDocument else None, activeCreationId=app.activeDocument.creationId if app.activeDocument else None)`)}`),
          );
          assert.ok(Array.isArray(after["documents"]));
          assert.equal(after["creationId"], own.creationId);
          const testDocumentRemainsOpen = after["documents"]
            .map(record)
            .some((d) => d["creationId"] === own.creationId);
          assert.equal(testDocumentRemainsOpen, false);
          const completionPath = path.join(
            session.directory,
            "legacy/completion.json",
          );
          if (fs.existsSync(completionPath)) {
            const completion = record(
              JSON.parse(fs.readFileSync(completionPath, "utf8")) as unknown,
            );
            assert.deepEqual(completion["owner"], session.report.owner);
            assert.deepEqual(completion["document"], own);
            const filename = text(completion["reportPath"]);
            assert.equal(
              filename,
              path.join(session.directory, "legacy/readback.json"),
            );
            const report = record(
              JSON.parse(fs.readFileSync(filename, "utf8")) as unknown,
            );
            assert.ok(Array.isArray(report["tests"]));
            report["tests"].push(
              {
                name: "doc close --discard with immediate owned identity assertion",
                status: "passed",
              },
              {
                name: "non-target documents preserved during close and exact owned document absent",
                status: "passed",
              },
            );
            report["after"] = after;
            report["testDocumentRemainsOpen"] = testDocumentRemainsOpen;
            fs.writeFileSync(filename, JSON.stringify(report, null, 2) + "\n", {
              mode: 0o600,
            });
          }
        }
      }
    },
  }));
}
