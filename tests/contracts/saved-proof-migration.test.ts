import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../../..");
const runtimeRequire = createRequire(
  path.join(root, "tests/contracts/saved-proof-migration.test.js"),
);
const { parseSavedFixtureReader } = runtimeRequire(
  "../../src/queue-saved-fixture-reader",
) as typeof import("../../packages/core/src/application/cad/saved-fixture-proof");
const { hash } = runtimeRequire(
  "../../src/dist/core/application/cad/json",
) as typeof import("../../packages/core/src/application/cad/json");
const historical = {
  exports:
    {} as typeof import("../../packages/core/src/application/cad/saved-fixture-proof") &
      typeof import("../../packages/node-adapters/src/persistence/saved-fixture-reader"),
};
const load = vm.runInThisContext(
  "(function(module, require) {" +
    fs.readFileSync(
      path.join(
        root,
        "tests/fixtures/history/queue-saved-fixture-reader-330849f.js.txt",
      ),
      "utf8",
    ) +
    "\n})",
) as (module: typeof historical, require: NodeJS.Require) => void;
load(
  historical,
  createRequire(path.join(root, "src/queue-saved-fixture-reader.js")),
);

for (const purpose of [
  "saved-fixture-retain-v1",
  "saved-fixture-destination-v1",
  "saved-first-save-publication-v1",
]) {
  test(`saved proof migration preserves ${purpose} and rejection boundaries`, () => {
    const binding = {
      purpose,
      epochId: "owned",
      document: { name: "OWNED", creationId: "doc-id", fileId: null },
      savedDocument: { fileId: "new-file" },
      restoreActiveCreationId: "original",
      destination: {
        projectName: "APPROVED",
        folderName: "NEW",
        folderId: "folder",
      },
    };
    const proof = {
      version: 1,
      purpose,
      epochId: binding.epochId,
      bindingHash: hash(binding),
      document: binding.document,
      ...(purpose === "saved-fixture-retain-v1"
        ? {
            savedDocument: binding.savedDocument,
            closed: true,
            saved: true,
            retained: true,
            activeBeforeCloseCreationId: "doc-id",
            restoredActiveCreationId: "original",
            activeDocumentRestored: true,
          }
        : purpose === "saved-fixture-destination-v1"
          ? {
              readOnly: true,
              destination: {
                ...binding.destination,
                nativeProjectId: "native",
                nativeHubId: "hub",
                nativeHubName: "hub-name",
              },
            }
          : { readOnly: true, observed: binding.document }),
    };
    const reply = (value: unknown) => ({
      result: {
        content: [
          { type: "text", text: "FMCAD_RESULT " + JSON.stringify(value) },
        ],
      },
    });
    assert.deepEqual(parseSavedFixtureReader(reply(proof), {}, binding), proof);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          historical.exports.parseSavedFixtureReader(reply(proof), {}, binding),
        ),
      ),
      proof,
    );
    for (const changes of [
      { bindingHash: "foreign" },
      { epochId: "foreign" },
      { nativeQualified: true },
      { document: { ...binding.document, creationId: "foreign" } },
    ]) {
      for (const parse of [
        parseSavedFixtureReader,
        historical.exports.parseSavedFixtureReader,
      ]) {
        assert.throws(
          () => parse(reply({ ...proof, ...changes }), {}, binding),
          { code: "SAVED_FIXTURE_PROOF_INVALID" },
        );
      }
    }
  });
}

test("saved administrative preparation preserves exact historical Python bytes", (t) => {
  const install = runtimeRequire(
    "../fixtures/fake-wsl-platform.cjs",
  ) as () => () => void;
  t.after(install());
  const { prepareSavedFixtureReader } = runtimeRequire(
    "../../src/queue-saved-fixture-reader",
  ) as typeof import("../../packages/node-adapters/src/persistence/saved-fixture-reader");
  for (const [purpose, filename] of [
    ["saved-fixture-retain-v1", "sdk-retained.json"],
    ["saved-fixture-destination-v1", "sdk-destination.json"],
    ["saved-first-save-publication-v1", "sdk-publication.json"],
  ] as const) {
    const directory = "/tmp/fmcad-saved-proof-parity";
    const binding = {
      purpose,
      epochId: "owned",
      sdkProofPath: path.join(directory, filename),
      document: { creationId: "owned", name: "Żółć", fileId: null },
      destination: { folderId: "new" },
      savedDocument: { fileId: "new-file" },
      restoreActiveCreationId: null,
    };
    const before = historical.exports.prepareSavedFixtureReader(
      root,
      {},
      binding,
      { directory },
    );
    const after = prepareSavedFixtureReader(root, {}, binding, { directory });
    assert.deepEqual(after, before);
  }
});
