import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { createEpochPrerequisite } from "../packages/node-adapters/src/execution/epoch-prerequisite";
const load = createRequire(__filename);
type Reader = ReturnType<typeof createEpochPrerequisite>;
const current = load("../src/queue-epoch-prerequisite") as Reader;
const historicalModule = load("./fixtures/historical-module.cjs") as (
  revision: string,
  sourcePath: string,
) => unknown;
const historical = historicalModule(
  "330849f22302bcf0ee955cd1945ddb2040eff8c7",
  "src/queue-epoch-prerequisite.js",
) as Reader;
const api = load("../src/queue-instance") as {
  durable(path: string, value: unknown, exclusive?: boolean): void;
  hash(value: string | Uint8Array): string;
};
interface AuditResult {
  summary: {
    modulePresent: boolean;
    ui: { activeCommand: string; idle: boolean };
  };
  sdkRequestsSent: number;
  endpointVerified: boolean;
  clientId: string;
  currentInstance: { birth: string };
}
interface ProofFixture {
  files: { auditResult: { path: string; sha256: string } };
  records: { auditResult: AuditResult };
}
test("typed epoch prerequisite preserves predecessor proof and refuses rehashed unsafe facts", (t) => {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const root = fs.mkdtempSync(
    path.join(
      (load("node:os") as typeof import("node:os")).tmpdir(),
      "prerequisite-parity-",
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = {
    jobId: "holder",
    observationJobId: "3627db2e-0b9d-4e4f-927f-20cb45deae74",
  };
  // These are evidence records, not a replacement for the production process observer.
  // This pure proof reader never inspects or launches a process.
  const selected = { pid: 1, birth: "synthetic-current", version: "fixture" };
  const original = { pid: 2, birth: "synthetic-original", version: "fixture" };
  const identity = {
    commandId: "fmcad_atomic_" + "a".repeat(32),
    sessionNonce: "b".repeat(32),
    resolvedIdentity: {
      name: "Historical",
      creationId: "historical-id",
      fileId: null,
    },
  };
  const createFixture = load("./fixtures/epoch-audit.cjs") as (
    root: string,
    scope: unknown,
    identity: unknown,
    current: unknown,
    original: unknown,
    owner: unknown,
  ) => ProofFixture;
  const f = createFixture(root, scope, identity, selected, original, {
    nonce: "prior",
  });
  const read = (reader: Reader) =>
    reader.epochAuditPrerequisite(
      f.files,
      root,
      { currentInstance: selected },
      scope,
    );
  assert.deepEqual(read(current), read(historical));
  const proof = read(current),
    pauseId = "first:pause";
  const preceding = path.join(root, "previous-complete.json");
  api.durable(
    preceding,
    {
      requestId: "first",
      previousOwner: { nonce: "original" },
      originalBuildHash: "old",
    },
    true,
  );
  api.durable(
    path.join(root, "lifecycle-control-" + api.hash(pauseId) + ".json"),
    {
      status: "completed",
      binding: {
        action: "pause",
        clientId: "original-owner",
        requestId: pauseId,
        instanceId: "original",
        buildHash: "old",
        expectedGeneration: 24,
      },
      result: {
        requestId: pauseId,
        instanceId: "original",
        buildHash: "old",
        generation: 25,
        contextEpoch: 12,
        gateClosed: true,
        activeOperations: 0,
        activeIds: [],
      },
    },
    true,
  );
  const snapshot = {
    owner: { nonce: "departing" },
    identity: { buildHash: "old" },
    state: {
      paused: true,
      controlGeneration: 25,
      contextEpoch: 12,
      controlRequests: { [pauseId]: { paused: true, generation: 25 } },
    },
    status: {
      paused: true,
      control: {
        instanceId: "departing",
        generation: 25,
        contextEpoch: 12,
        gateClosed: true,
        activeOperations: 0,
        activeIds: [],
      },
    },
  };
  const inherited = {
    initial: structuredClone(snapshot),
    current: structuredClone(snapshot),
    intent: {
      nonce: "migration",
      binding: { clientId: "original-owner", requestId: "upgrade" },
    },
    upgrade: {
      epochPrerequisite: proof,
      previousComplete: { path: preceding },
    },
    clientId: "original-owner",
    dir: root,
  };
  assert.deepEqual(
    current.inheritedEpochPause(inherited),
    historical.inheritedEpochPause(inherited),
  );
  const changes: Array<(value: typeof inherited) => void> = [
    (value) => {
      value.clientId = "foreign";
    },
    (value) => {
      value.current.status.control.activeOperations = 1;
    },
    (value) => {
      value.current.status.control.generation++;
    },
    (value) => {
      Object.assign(value.current.state, { changed: true });
    },
  ];
  for (const change of changes) {
    const value = structuredClone(inherited);
    change(value);
    for (const reader of [current, historical])
      assert.throws(() => reader.inheritedEpochPause(value));
  }
  const mutations: Array<(value: AuditResult) => void> = [
    (value) => {
      value.summary.modulePresent = true;
    },
    (value) => {
      value.summary.ui = { activeCommand: "SketchLine", idle: false };
    },
    (value) => {
      value.sdkRequestsSent = 0;
    },
    (value) => {
      value.endpointVerified = false;
    },
    (value) => {
      value.clientId = "foreign";
    },
    (value) => {
      value.currentInstance.birth = "foreign";
    },
  ];
  for (const mutation of mutations) {
    const value = structuredClone(f.records.auditResult);
    mutation(value);
    api.durable(f.files.auditResult.path, value);
    f.files.auditResult.sha256 = api.hash(
      fs.readFileSync(f.files.auditResult.path),
    );
    for (const reader of [current, historical])
      assert.throws(() => read(reader));
  }
});
