import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type {
  QueueJob,
  QueueRequest,
} from "../packages/core/src/domain/queue-model";
interface StoredGrant {
  nativeFixture: {
    script: string;
    scriptSha256: string;
    manifestSha256: string;
  };
}
interface FixedPayload extends Record<string, unknown> {
  version: 1;
  kind: "run";
  output?: { path: string };
  request: {
    name: string;
    hasArgs: boolean;
    helperVersion: string;
    readOnlyOperations: string[];
    doc: string;
    identity: { docId: string };
    args: {
      approved: boolean;
      creationId: string;
      expectedFusionVersion: string;
      fixturePrefix: string;
      expectedRatio?: number;
      targetRadians?: number;
      skipCases?: boolean;
    };
  };
}

import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";
const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "native-fixture-grant.test.js"),
);

const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { grantNativeFixture, fixtureGrantOperations } = load(
  "../src/queue-native-fixture-grant",
) as typeof import("../src/queue-native-fixture-grant");
const { openIsolatedEpoch, epochAdmission } = load(
  "../src/queue-isolated-epoch",
) as typeof import("../src/queue-isolated-epoch");

function fixture(t: TestContext, fixtureId = "regional-geometry-v1") {
  const root = fs.mkdtempSync("/tmp/opencode/native-fixture-grant-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      root: string,
      options?: { oldProcessAlive?: boolean; inFlight?: boolean },
    ) => DeadEpochFixture
  )(root, repository);
  const state = openIsolatedEpoch(f.dir, { recover: false });
  state.installEpoch(f.pointer, f.identity, f.initialization);
  const clients = {
    [f.clientId]: state.epoch!.ownerTokenHash,
    native: api.hash("synthetic-native-client-token"),
  };
  api.durable(path.join(f.dir, "clients.json"), clients);
  const p = {
    dir: f.dir,
    state,
    buildHash: api.buildHash(),
    clients: () => clients,
    assertControl: (value: unknown) =>
      assert.deepEqual(value, { synthetic: true }),
    fence() {},
  };
  const message = {
    action: "grant-native-fixture",
    epochId: state.epoch!.epochId,
    grantClientId: "native",
    fixtureId,
    requestId: "synthetic-native-grant",
    control: { synthetic: true },
  };
  const grantFile = path.join(
    state.epoch!.root,
    "access-" + api.hash("native\0" + clients.native) + ".json",
  );
  function typed(
    operation = "shape.box",
    changes: Record<string, unknown> = {},
  ): QueueRequest & { inputFiles: unknown[] } {
    const payload = {
      version: 1 as const,
      kind: "cad" as const,
      operation,
      doc: state.epoch!.document.name,
      docId: state.epoch!.document.creationId,
      data: {},
      ...changes,
    };
    return {
      kind: "command",
      clientId: "native",
      requestId: "synthetic-model-operation",
      timeoutMs: 1000,
      cwd: root,
      inputFiles: [],
      payload,
      argv: (
        load(
          "../src/cad-service",
        ) as typeof import("../src/composition/cad-service")
      ).policyArguments(payload),
    };
  }
  return {
    ...f,
    state,
    p,
    clients,
    message,
    grantFile,
    typed,
    grant: () => grantNativeFixture(p, message, f.clientId),
  };
}

test("FAKE metadata: explicit native grant admits only its typed operation set on the new owned scratch", (t) => {
  const f = fixture(t),
    result = f.grant();
  assert.equal(result.nativeFixture.fixtureId, "regional-geometry-v1");
  assert.equal(
    (result.nativeFixture.operations as string[]).includes(
      "geometry.compare-region",
    ),
    true,
  );
  assert.deepEqual(f.grant(), result);
  assert.doesNotThrow(() =>
    epochAdmission(f.state, f.typed("shape.box"), f.clients),
  );
  assert.doesNotThrow(() =>
    epochAdmission(f.state, f.typed("geometry.compare-region"), f.clients),
  );
  assert.throws(
    () => epochAdmission(f.state, f.typed("model.extrude"), f.clients),
    { code: "EPOCH_SCOPE_REQUIRED" },
  );
  assert.throws(
    () => epochAdmission(f.state, f.typed("batch.run"), f.clients),
    { code: "EPOCH_SCOPE_REQUIRED" },
  );
  assert.throws(
    () =>
      epochAdmission(
        f.state,
        f.typed("shape.box", { docId: "user-document" }),
        f.clients,
      ),
    { code: "EPOCH_SCOPE_REQUIRED" },
  );
  const fileEffect = f.typed();
  fileEffect.inputFiles = [{ path: "/unapproved-file" }];
  assert.throws(() => epochAdmission(f.state, fileEffect, f.clients), {
    code: "EPOCH_SCOPE_REQUIRED",
  });
});

test("FAKE metadata: an ordinary smoke grant cannot be broadened by issuing a native grant over it", (t) => {
  const f = fixture(t);
  api.durable(
    f.grantFile,
    {
      epochId: f.state.epoch!.epochId,
      clientId: "native",
      clientTokenHash: f.clients.native,
      document: f.state.epoch!.document,
    },
    true,
  );
  assert.throws(f.grant, { code: "GRANT_SCOPE_CONFLICT" });
  assert.throws(() => epochAdmission(f.state, f.typed(), f.clients), {
    code: "EPOCH_SCOPE_REQUIRED",
  });
});

test("FAKE metadata: native authority is not promoted implicitly to a different runtime/source or manifest", (t) => {
  const f = fixture(t);
  f.grant();
  const grant = api.readJson(f.grantFile) as StoredGrant,
    identity = api.readJson(
      path.join(f.state.epoch!.root, "instance.json"),
    ) as { buildHash: string; sourceCommit: string };
  assert.throws(
    () =>
      fixtureGrantOperations(grant, { ...identity, buildHash: "d".repeat(64) }),
    { code: "NATIVE_FIXTURE_CHANGED" },
  );
  assert.throws(
    () =>
      fixtureGrantOperations(grant, {
        ...identity,
        sourceCommit: "e".repeat(40),
      }),
    { code: "NATIVE_FIXTURE_CHANGED" },
  );
  grant.nativeFixture.manifestSha256 = "f".repeat(64);
  assert.throws(() => fixtureGrantOperations(grant, identity), {
    code: "NATIVE_FIXTURE_CHANGED",
  });
});

test("FAKE metadata: a grantee is not the owner and a modified managed epoch is not fresh", (t) => {
  const f = fixture(t);
  assert.throws(() => grantNativeFixture(f.p, f.message, "native"), {
    code: "NOT_OWNER",
  });
  f.state.data.jobs["synthetic"] = { state: "succeeded" } as QueueJob;
  assert.throws(f.grant, { code: "NATIVE_FIXTURE_FRESH_EPOCH_REQUIRED" });
  assert.equal(fs.existsSync(f.grantFile), false);
});

test("FAKE metadata: successful typed readiness reads preserve freshness but model operations do not", (t) => {
  const f = fixture(t);
  f.state.data.jobs["readiness"] = {
    kind: "command",
    state: "succeeded",
    details: { sdkSettled: true },
    request: {
      payload: {
        kind: "cad",
        operation: "document.status",
        doc: f.state.epoch!.document.name,
        docId: f.state.epoch!.document.creationId,
      },
    },
    dispatch: { rpcCount: 1, completedCount: 1 },
    sequenceId: null,
  } as unknown as QueueJob;
  assert.doesNotThrow(f.grant);
});

function fixedRequest(
  f: ReturnType<typeof fixture>,
  fixturePrefix = "NQABCDEF12",
) {
  const grant = api.readJson(f.grantFile) as StoredGrant;
  const installation = (
    load(
      "../src/dist/config-platform",
    ) as typeof import("../packages/node-adapters/src/config-platform")
  ).resolveRuntimePaths({
    anchor: path.join(repository, "tests/native-fixture-grant.test.js"),
  }).installation;
  const script = path.join(installation, grant.nativeFixture.script);
  const payload: FixedPayload = {
    version: 1,
    kind: "run",
    request: {
      name: script,
      hasArgs: true,
      helperVersion: "cad-v1",
      readOnlyOperations: [],
      doc: f.state.epoch!.document.name,
      identity: { docId: f.state.epoch!.document.creationId },
      args: {
        approved: true,
        creationId: f.state.epoch!.document.creationId,
        expectedFusionVersion: f.state.epoch!.currentInstance.version,
        fixturePrefix,
      },
    },
  };
  return {
    kind: "command" as const,
    clientId: "native",
    requestId: "fixed-program-once",
    timeoutMs: 180000,
    cwd: f.dir,
    payload,
    argv: (
      load(
        "../src/cad-service",
      ) as typeof import("../src/composition/cad-service")
    ).policyArguments(payload),
    inputFiles: [{ path: script, sha256: grant.nativeFixture.scriptSha256 }],
  };
}

test("FAKE admission: fixed program scope admits the registered source only, not general run or catalog privileges", (t) => {
  const f = fixture(t, "containment-program-v1");
  f.grant();
  assert.doesNotThrow(() =>
    epochAdmission(f.state, fixedRequest(f), f.clients),
  );
  assert.throws(() => epochAdmission(f.state, f.typed(), f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

test("FAKE CLI admission: an output-free cad-v1 run matches the fixed source contract", (t) => {
  const f = fixture(t, "containment-program-v1");
  f.grant();
  const script = path.resolve(
    repository,
    "assets/native-qualification/containment.py",
  );
  const converted = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).fromParsedCommand({
    kind: "run",
    request: {
      name: script,
      args: {
        approved: true,
        creationId: f.state.epoch!.document.creationId,
        expectedFusionVersion: f.state.epoch!.currentInstance.version,
        fixturePrefix: "NQCLI001",
      },
      hasArgs: true,
      helperVersion: "cad-v1",
      doc: f.state.epoch!.document.name,
      identity: { docId: f.state.epoch!.document.creationId, readOnly: false },
    },
  });
  const request = {
    kind: "command" as const,
    clientId: "native",
    requestId: "fixed-run-from-cli",
    timeoutMs: 180000,
    cwd: repository,
    payload: converted.payload as typeof converted.payload &
      Record<string, unknown>,
    argv: converted.argv,
    inputFiles: [
      {
        path: script,
        sha256: (
          load(
            "../src/queue-atomic-migration-files",
          ) as typeof import("../packages/node-adapters/src/persistence/migration-files")
        ).fileHash(script).sha256,
      },
    ],
  };
  assert.equal(Object.hasOwn(request.payload, "output"), false);
  assert.deepEqual(
    (request.payload as { request: { readOnlyOperations: unknown } }).request
      .readOnlyOperations,
    [],
  );
  assert.doesNotThrow(() => epochAdmission(f.state, request, f.clients));
});

test("FAKE admission: GM12 grant admits only its exact fixed program, not general CAD calls", (t) => {
  const f = fixture(t, "gm12-spring-program-v1");
  const result = f.grant();
  assert.equal(result.nativeFixture.fixtureId, "gm12-spring-program-v1");
  assert.equal(
    (
      result.nativeFixture as Extract<
        import("../src/queue-native-fixture-grant").FixtureContract,
        { kind: "fixed-run-v1" }
      >
    ).script,
    "assets/native-qualification/gm12-spring.py",
  );
  const request = fixedRequest(f);
  assert.doesNotThrow(() => epochAdmission(f.state, request, f.clients));
  assert.throws(
    () => epochAdmission(f.state, f.typed("spring.evaluate"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
  request.payload.request.name = request.payload.request.name.replace(
    "/gm12-spring.py",
    "/containment.py",
  );
  request.inputFiles[0]!.path = request.payload.request.name;
  request.argv = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments(request.payload);
  assert.throws(() => epochAdmission(f.state, request, f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

test("FAKE admission: GM07 curves grant admits only its exact fixed program", (t) => {
  const f = fixture(t, "gm07-curves-program-v1");
  const result = f.grant();
  assert.equal(result.nativeFixture.fixtureId, "gm07-curves-program-v1");
  assert.equal(
    (
      result.nativeFixture as Extract<
        import("../src/queue-native-fixture-grant").FixtureContract,
        { kind: "fixed-run-v1" }
      >
    ).script,
    "assets/native-qualification/gm07-curves.py",
  );
  assert.doesNotThrow(() =>
    epochAdmission(f.state, fixedRequest(f, "NQGM07CURVE01"), f.clients),
  );
  assert.throws(
    () => epochAdmission(f.state, f.typed("curve.fit"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
});

test("FAKE admission: data-import grant admits only its exact fixed program", (t) => {
  const f = fixture(t, "data-import-program-v1");
  const result = f.grant();
  assert.equal(result.nativeFixture.fixtureId, "data-import-program-v1");
  assert.equal(
    (
      result.nativeFixture as Extract<
        import("../src/queue-native-fixture-grant").FixtureContract,
        { kind: "fixed-run-v1" }
      >
    ).script,
    "assets/native-qualification/data-import.py",
  );
  assert.doesNotThrow(() =>
    epochAdmission(f.state, fixedRequest(f, "NQGM07IMPORT01"), f.clients),
  );
  assert.throws(
    () => epochAdmission(f.state, f.typed("catalog.import"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
});

test("FAKE admission: section program has its own source grant and cannot substitute the containment source", (t) => {
  const f = fixture(t, "sections-program-v1");
  f.grant();
  const r = fixedRequest(f);
  assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  r.payload.request.name = r.payload.request.name.replace(
    "/sections.py",
    "/containment.py",
  );
  r.inputFiles[0]!.path = r.payload.request.name;
  r.argv = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments(r.payload);
  assert.throws(() => epochAdmission(f.state, r, f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

test("FAKE admission: sketch proof has a distinct exact program grant, not general sketch or other fixture permission", (t) => {
  const f = fixture(t, "sketch-proof-program-v1");
  f.grant();
  const r = fixedRequest(f);
  assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  assert.throws(
    () => epochAdmission(f.state, f.typed("sketch.geometry"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
  r.payload.request.name = r.payload.request.name.replace(
    "/sketch-proof.py",
    "/sections.py",
  );
  r.inputFiles[0]!.path = r.payload.request.name;
  r.argv = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments(r.payload);
  assert.throws(() => epochAdmission(f.state, r, f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

test("FAKE admission: measured fasteners grant accepts only its exact native datum program", (t) => {
  const f = fixture(t, "measured-fasteners-program-v1");
  f.grant();
  const r = fixedRequest(f);
  assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  assert.throws(
    () => epochAdmission(f.state, f.typed("datum.point"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
  r.payload.request.name = r.payload.request.name.replace(
    "/measured-fasteners.py",
    "/sketch-proof.py",
  );
  r.inputFiles[0]!.path = r.payload.request.name;
  r.argv = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments(r.payload);
  assert.throws(() => epochAdmission(f.state, r, f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

test("FAKE admission: Drive/MotionLink fixed scope is not general assembly or arbitrary program permission", (t) => {
  const f = fixture(t, "drive-motion-program-v1");
  f.grant();
  const r = fixedRequest(f);
  assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  assert.throws(
    () => epochAdmission(f.state, f.typed("component.create"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
  r.payload.request.args.expectedRatio = 2;
  r.argv = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments(r.payload);
  assert.throws(() => epochAdmission(f.state, r, f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

test("FAKE admission: precision diagnosis permits only its fixed targets and exact source", (t) => {
  const f = fixture(t, "drive-precision-program-v1");
  f.grant();
  const r = fixedRequest(f);
  assert.doesNotThrow(() => epochAdmission(f.state, r, f.clients));
  assert.throws(
    () => epochAdmission(f.state, f.typed("joint.drive"), f.clients),
    { code: "NATIVE_FIXTURE_SCOPE_REQUIRED" },
  );
  r.payload.request.args.targetRadians = 0.05;
  r.argv = (
    load(
      "../src/cad-service",
    ) as typeof import("../src/composition/cad-service")
  ).policyArguments(r.payload);
  assert.throws(() => epochAdmission(f.state, r, f.clients), {
    code: "NATIVE_FIXTURE_SCOPE_REQUIRED",
  });
});

for (const [name, change] of [
  [
    "other source path",
    (r) => {
      r.payload.request.name = "/unapproved/source.py";
    },
  ],
  [
    "other source hash",
    (r) => {
      r.inputFiles[0]!.sha256 = "f".repeat(64);
    },
  ],
  [
    "extra input file",
    (r) => {
      r.inputFiles.push({ path: "/unapproved/file", sha256: "a".repeat(64) });
    },
  ],
  [
    "other document",
    (r) => {
      r.payload.request.identity.docId = "user-document";
    },
  ],
  [
    "other helper",
    (r) => {
      r.payload.request.helperVersion = "unapproved";
    },
  ],
  [
    "read-only exception list",
    (r) => {
      r.payload.request.readOnlyOperations = ["document.save"];
    },
  ],
  [
    "output file effect",
    (r) => {
      r.payload.output = { path: "/unapproved/output" };
    },
  ],
  [
    "extra program argument",
    (r) => {
      r.payload.request.args.skipCases = true;
    },
  ],
  [
    "other Fusion version",
    (r) => {
      r.payload.request.args.expectedFusionVersion = "different";
    },
  ],
  [
    "other argument document",
    (r) => {
      r.payload.request.args.creationId = "user-document";
    },
  ],
  [
    "unsafe prefix",
    (r) => {
      r.payload.request.args.fixturePrefix = "../other";
    },
  ],
] satisfies ReadonlyArray<
  readonly [string, (r: ReturnType<typeof fixedRequest>) => void]
>)
  test("FAKE admission: fixed program refuses " + name, (t) => {
    const f = fixture(t, "containment-program-v1");
    f.grant();
    const r = fixedRequest(f);
    change(r);
    assert.throws(() => epochAdmission(f.state, r, f.clients));
  });
