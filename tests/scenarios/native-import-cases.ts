import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "./runner";
import { emit, program } from "./programs";
import { record, text } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { parseDocumentSnapshot } from "../import-result-contracts";
import {
  assertActiveDocumentRestored,
  assertProtectedBaselineDocuments,
} from "../live-import-receipts";

export const nativeImportCapability = "native-import-step-effects";

/** The retained exact CLI assertions run inside the existing durable unsaved owner lifecycle. */
export function nativeImportScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-import-" + index,
    scope: "exclusive-instance",
    requires: ["documents", "owned-child-cli", nativeImportCapability],
    async run(session) {
      const own = session.document;
      assert.equal(own.file, undefined, "Test document must remain unsaved");
      try {
        await session.legacyScript();
      } finally {
        await session.cleanup();
        if (session.report.cleanup === "complete") {
          const index = record(
            JSON.parse(
              fs.readFileSync(
                path.join(session.directory, "..", "index.json"),
                "utf8",
              ),
            ) as unknown,
          );
          const baseline = record(index["before"]);
          const original = parseDocumentSnapshot(
            {
              documents: baseline["documents"],
              activeCreationId: baseline["active"],
            },
            "Original import baseline",
          );
          const closed = await session.observe(
            "observe-import-after-cleanup",
            program(`import adsk.core, json
app = adsk.core.Application.get()
assert not any(d.creationId == ${JSON.stringify(own.creationId)} for d in app.documents), 'Close(False) did not remove the exact owned document'
documents = [dict(creationId=d.creationId, name=d.name, saved=d.isSaved, modified=d.isModified, fileId=d.dataFile.id if d.isSaved and d.dataFile else None) for d in app.documents]
${emit(`dict(creationId=${JSON.stringify(own.creationId)}, closedCreationId=${JSON.stringify(own.creationId)}, documents=documents, activeCreationId=app.activeDocument.creationId if app.activeDocument else None)`)}`),
          );
          assert.equal(closed["closedCreationId"], own.creationId);
          const after = parseDocumentSnapshot(
            closed,
            "Post-cleanup Fusion document inventory",
          );
          assert.equal(
            after.documents.some((doc) => doc.creationId === own.creationId),
            false,
            "Close(False) did not remove the exact owned document",
          );
          assertProtectedBaselineDocuments(
            original,
            after,
            "After closing the owned fixture",
          );
          assertActiveDocumentRestored(original, after, "Close(False)");
          const completionFile = path.join(
            session.directory,
            "legacy/completion.json",
          );
          if (fs.existsSync(completionFile)) {
            const completion = record(
              JSON.parse(fs.readFileSync(completionFile, "utf8")) as unknown,
            );
            assert.deepEqual(completion["owner"], session.report.owner);
            assert.deepEqual(completion["document"], own);
            const reportPath = text(completion["reportPath"]);
            for (const filename of [
              reportPath,
              text(completion["catalogPath"]),
              text(completion["stepPath"]),
            ])
              assert.ok(
                path
                  .resolve(filename)
                  .startsWith(
                    path.join(session.directory, "legacy/artifacts") + path.sep,
                  ),
                "Foreign synthetic artifact path",
              );
            for (const filename of [
              text(completion["catalogPath"]),
              text(completion["stepPath"]),
            ])
              if (fs.existsSync(filename)) fs.unlinkSync(filename);
            const report = record(
              JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown,
            );
            report["after"] = after;
            report["cleanup"] = {
              closedCreationId: closed["closedCreationId"],
              protectedDocumentsRestored: true,
              activeDocumentRestored: after.activeCreationId,
              syntheticFilesRemoved: true,
            };
            fs.writeFileSync(
              reportPath,
              JSON.stringify(report, null, 2) + "\n",
              { mode: 0o600 },
            );
          }
        }
      }
    },
  }));
}
