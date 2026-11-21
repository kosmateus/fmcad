import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "./runner";
import { record, text } from "./contracts";
import { program, emit } from "./programs";
import { concurrencyLimit } from "./scheduling";
import {
  assertReceiptBoundDocumentInventory,
  discoverOwnedUnsavedFixtureProofs,
  originalActiveDocument,
} from "./fixture-provenance";
import { marker } from "./programs";

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
          const after = await session.observe(
            "observe-legacy-after-cleanup",
            program(`import adsk.core, json
app = adsk.core.Application.get()
assert not any(d.creationId == ${JSON.stringify(own.creationId)} for d in app.documents)
documents = [dict(name=d.name, creationId=d.creationId, fileId=d.dataFile.id if d.dataFile else None, modified=d.isModified, saved=d.isSaved, active=d == app.activeDocument) for d in app.documents]
${emit(`dict(creationId=${JSON.stringify(own.creationId)}, documents=documents, active=app.activeDocument.name if app.activeDocument else None, activeCreationId=app.activeDocument.creationId if app.activeDocument else None)`)}`),
          );
          assert.ok(Array.isArray(after["documents"]));
          const coordinator = record(
            JSON.parse(
              fs.readFileSync(
                path.join(session.directory, "..", "index.json"),
                "utf8",
              ),
            ) as unknown,
          );
          const before = record(coordinator["before"]);
          assert.ok(Array.isArray(before["documents"]));
          assert.equal(coordinator["runId"], session.report.owner.runId);
          const original = record(
              JSON.parse(
                fs.readFileSync(
                  path.join(
                    session.directory,
                    "..",
                    "_coordinator/before.result.json",
                  ),
                  "utf8",
                ),
              ) as unknown,
            ),
            clientId = `scenario:${session.report.owner.runId}:coordinator`,
            requestId = clientId + ":before",
            receipt = record(original["brokerReceipt"]);
          assert.equal(original["requestId"], requestId);
          assert.equal(original["state"], "succeeded");
          assert.equal(original["sdkSettled"], true);
          assert.equal(receipt["requestId"], requestId);
          assert.equal(receipt["clientId"], clientId);
          assert.equal(receipt["state"], "succeeded");
          text(receipt["jobId"]);
          const lines = text(original["stdout"])
            .split(/\r?\n/u)
            .filter((line) => line.startsWith(marker));
          assert.equal(lines.length, 1);
          const observed = record(
            JSON.parse(lines[0]!.slice(marker.length)) as unknown,
          );
          assert.equal(observed["active"], before["active"]);
          assert.ok(Array.isArray(observed["documents"]));
          const seen = new Set(
              observed["documents"].map((row) =>
                text(record(row)["creationId"]),
              ),
            ),
            relevant = new Set([
              ...seen,
              ...after["documents"].map((row) =>
                text(record(row)["creationId"]),
              ),
            ]),
            proofs = new Map(
              [
                ...discoverOwnedUnsavedFixtureProofs(
                  path.dirname(path.dirname(session.directory)),
                  session.backend,
                ),
              ].filter(
                ([id, proof]) =>
                  relevant.has(id) ||
                  (proof.state === "saved" &&
                    relevant.has(proof.savedDocument.creationId)),
              ),
            );
          const testDocumentRemainsOpen = after["documents"]
            .map(record)
            .some((d) => d["name"] === own.name);
          assert.equal(testDocumentRemainsOpen, false);
          assertReceiptBoundDocumentInventory(
            before["documents"],
            after["documents"],
            proofs,
            "Legacy cleanup changed a protected document or an unproven peer",
            true,
            seen,
          );
          const settledPeers = new Map(
              [...proofs]
                .filter(
                  ([, proof]) =>
                    proof.state === "open" ||
                    proof.state === "closed" ||
                    (proof.state === "saved" &&
                      proof.savedState !== "unsettled"),
                )
                .map(([id, proof]) => [id, proof.document]),
            ),
            active = originalActiveDocument(
              before["active"],
              before["documents"],
              settledPeers,
            );
          if (active) {
            assert.equal(
              after["activeCreationId"],
              active.creationId,
              "Original user active document changed",
            );
            assert.equal(after["active"], active.name);
          }
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
                name: "existing documents preserved and no test remains",
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
