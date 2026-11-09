import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "./runner";
import { record, text } from "./contracts";
import { program, emit } from "./programs";
import { concurrencyLimit } from "./scheduling";

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
        await session.legacyScript("tests/live-legacy-owned.ts");
      } finally {
        await session.cleanup();
        if (session.report.cleanup === "complete") {
          const after = await session.observe(
            "observe-legacy-after-cleanup",
            program(`import adsk.core, json
app = adsk.core.Application.get()
assert not any(d.creationId == ${JSON.stringify(own.creationId)} for d in app.documents)
documents = [dict(name=d.name, creationId=d.creationId, modified=d.isModified, saved=d.isSaved, active=d == app.activeDocument) for d in app.documents]
${emit(`dict(creationId=${JSON.stringify(own.creationId)}, documents=documents, active=app.activeDocument.name if app.activeDocument else None)`)}`),
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
          const baseline = {
            documents: before["documents"].map((value) => {
              const d = record(value);
              return {
                name: d["name"],
                creationId: d["creationId"],
                modified: d["modified"],
                saved: d["saved"],
                active: d["creationId"] === before["active"],
              };
            }),
          };
          const testDocumentRemainsOpen = after["documents"]
            .map(record)
            .some((d) => d["name"] === own.name);
          assert.equal(testDocumentRemainsOpen, false);
          assert.deepEqual(after["documents"], baseline.documents);
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
