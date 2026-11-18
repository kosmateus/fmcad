import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support";
import * as programs from "./programs";
import type { Document } from "./contracts";

for (const changedId of [false, true]) {
  for (const mode of [
    "open",
    "closed",
    "foreign-file",
    "foreign-name",
    "missing",
    "closed-visible",
    "unproven",
    "both-visible",
  ] as const) {
    if (!changedId && mode === "both-visible") continue;
    test(`CAD saved transfer ${mode}, changed ID ${changedId}`, async (t) => {
      const { model, backend, directory } = await fixture(t, "addin");
      const original: Document = { creationId: "old-peer", name: "Peer" };
      const owned: Document = { creationId: "owned", name: "Owned" };
      const setup = await model.execute(
        programs.program(`import adsk.core, json
app = adsk.core.Application.get()
peer = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
peer.creationId = 'old-peer'
peer.name = 'Peer'
folder = app.data.dataProjects.item(0).rootFolder
assert peer.saveAs('SavedPeer', folder, '', '')
peer.creationId = ${JSON.stringify(changedId ? "new-peer" : "old-peer")}
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.creationId = 'owned'
doc.name = 'Owned'
print(json.dumps(dict(creationId=peer.creationId,name=peer.name,file=dict(fileId=peer.dataFile.id,version=peer.dataFile.versionNumber,folderId=folder.id,projectId=folder.parentProject.id))))`),
      );
      assert.equal(setup.success, true, setup.error);
      const savedDocument: programs.SavedPeerTransfer["savedDocument"] =
        JSON.parse(setup.stdout);
      if (mode === "closed" || mode === "missing") {
        assert.equal(
          (
            await model.execute(
              programs.program(`import adsk.core
next(d for d in adsk.core.Application.get().documents if d.creationId == ${JSON.stringify(savedDocument.creationId)}).close(False)`),
            )
          ).success,
          true,
        );
      }
      if (mode === "both-visible") {
        assert.equal(
          (
            await model.execute(
              programs.program(`import adsk.core
doc = adsk.core.Application.get().documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.creationId = 'old-peer'
doc.name = 'Peer'`),
            )
          ).success,
          true,
        );
      }
      const expected =
        mode === "foreign-file"
          ? {
              ...savedDocument,
              file: { ...savedDocument.file, fileId: "foreign-file" },
            }
          : mode === "foreign-name"
            ? { ...savedDocument, name: "Foreign" }
            : savedDocument;
      const result = await backend.execute({
        owner: {
          runId: "saved-transfer",
          scenarioId: "fence",
          clientId: "saved-transfer:fence",
        },
        requestId: "saved-transfer:fence:1",
        directory,
        target: owned,
        helpers: "cad-v1",
        source: programs.cadFence(
          owned,
          "shape.box",
          { name: "Box", width: "10 mm", depth: "10 mm", height: "10 mm" },
          [{ ...original, saved: false, fileId: null, modified: false }],
          [],
          [],
          "root",
          undefined,
          mode === "unproven"
            ? []
            : [
                {
                  document: original,
                  savedDocument: expected,
                  savedState:
                    mode === "closed" || mode === "closed-visible"
                      ? "closed"
                      : "open",
                },
              ],
        ),
      });
      const positive = mode === "open" || mode === "closed";
      assert.equal(
        result.state,
        positive ? "succeeded" : "failed",
        result.stdout,
      );
      assert.match(
        result.stdout,
        positive ? /"status": "completed"/u : /"helperCallsOnly": \[\]/u,
      );
    });
  }
}
