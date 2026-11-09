import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const current = load(
  "./src/queue-fixed-fixture-admission",
) as typeof import("../src/queue-fixed-fixture-admission");
const retained = (
  load("./tests/fixtures/historical-module.cjs") as (
    revision: string,
    source: string,
  ) => typeof current
)(
  "270096ca6aaa4dfe67d68c89f0eec898a8845ebb",
  "src/queue-fixed-fixture-admission.js",
);
const { fixtureContract } = load("./src/queue-native-fixture-grant") as {
  fixtureContract(id: string): {
    script: string;
    scriptSha256: string;
    [key: string]: unknown;
  };
};
const service = load(
  "./src/cad-service",
) as typeof import("../src/composition/cad-service");
function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-admission-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = { buildHash: "a".repeat(64), sourceCommit: "b".repeat(40) };
  fs.writeFileSync(
    path.join(directory, "instance.json"),
    JSON.stringify(identity),
  );
  const contract = fixtureContract("containment-program-v1");
  const epoch = {
    root: directory,
    document: { name: "OWNED", creationId: "owned-id" },
    currentInstance: { version: "fixture-version" },
  };
  const grant = { nativeFixture: { version: 1, ...contract, ...identity } };
  const script = path.join(root, contract.script);
  const payload = {
    version: 1 as const,
    kind: "run" as const,
    request: {
      name: script,
      hasArgs: true,
      helperVersion: "cad-v1" as const,
      readOnlyOperations: [],
      doc: epoch.document.name,
      identity: { docId: epoch.document.creationId },
      args: {
        approved: true,
        creationId: epoch.document.creationId,
        expectedFusionVersion: epoch.currentInstance.version,
        fixturePrefix: "TESTFIXTURE1",
      },
    },
  };
  const request = {
    kind: "command",
    payload,
    inputFiles: [{ path: script, sha256: contract.scriptSha256 }],
    argv: service.policyArguments(payload),
  };
  return { epoch, request, grant, identity };
}
for (const [name, implementation] of [
  ["retained", retained],
  ["typed", current],
] as const) {
  test(`${name}: fixed source admission preserves exact owned source and arguments`, (t) => {
    const f = fixture(t),
      original = structuredClone(f.request);
    assert.doesNotThrow(() =>
      implementation.fixedFixtureAdmission(f.epoch, f.request, f.grant),
    );
    assert.deepEqual(f.request, original);
    assert.doesNotThrow(() =>
      implementation.fixedFixtureAdmission(f.epoch, f.request, f.grant, {
        identity: f.identity,
        installation: root,
      }),
    );
  });
  for (const mutation of [
    "foreign document",
    "foreign process version",
    "source hash",
    "arguments",
    "output",
    "other input",
    "policy argv",
    "changed grant",
  ] as const) {
    test(`${name}: refuses fixed fixture ${mutation}`, (t) => {
      const f = fixture(t);
      switch (mutation) {
        case "foreign document":
          f.request.payload.request.identity.docId = "foreign";
          break;
        case "foreign process version":
          f.request.payload.request.args.expectedFusionVersion = "foreign";
          break;
        case "source hash":
          f.request.inputFiles[0]!.sha256 = "0".repeat(64);
          break;
        case "arguments":
          Object.assign(f.request.payload.request.args, { extra: true });
          break;
        case "output":
          Object.assign(f.request.payload, { output: { out: "foreign.json" } });
          break;
        case "other input":
          f.request.inputFiles.push({
            path: "/foreign.py",
            sha256: "0".repeat(64),
          });
          break;
        case "policy argv":
          f.request.argv.push("--out", "foreign.json");
          break;
        case "changed grant":
          f.grant.nativeFixture.buildHash = "0".repeat(64);
          break;
      }
      assert.throws(
        () => implementation.fixedFixtureAdmission(f.epoch, f.request, f.grant),
        {
          code:
            mutation === "changed grant"
              ? "NATIVE_FIXTURE_CHANGED"
              : "NATIVE_FIXTURE_SCOPE_REQUIRED",
        },
      );
    });
  }
}
