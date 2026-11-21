import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const runtimeRequire = createRequire(
  path.join(
    process.env["FMCAD_TEST_RUNTIME"] || path.resolve(__dirname, ".."),
    "tests/queue-cli-recovery-parity.test.js",
  ),
);

test("TypeScript queue CLI retains qualified recovery dispatch and existing credentials", async (t) => {
  const calls: Record<string, unknown>[] = [];
  const saved = new Map<string, NodeModule | undefined>();
  function replace(name: string, exports: unknown) {
    const file = runtimeRequire.resolve(name);
    saved.set(file, runtimeRequire.cache[file]);
    const replacement = new Module(file);
    replacement.filename = file;
    replacement.loaded = true;
    replacement.exports = exports;
    runtimeRequire.cache[file] = replacement;
  }
  const entry = runtimeRequire.resolve("../src/dist/entrypoints/queue-cli.js");
  const previousEntry = runtimeRequire.cache[entry];
  delete runtimeRequire.cache[entry];
  t.after(() => {
    for (const [file, original] of saved) {
      if (original) runtimeRequire.cache[file] = original;
      else delete runtimeRequire.cache[file];
    }
    if (previousEntry) runtimeRequire.cache[entry] = previousEntry;
    else delete runtimeRequire.cache[entry];
  });
  class Client {
    constructor(
      id: unknown,
      options: { existingCredentialsOnly: boolean; cfg: { routing: string } },
    ) {
      assert.equal(options.existingCredentialsOnly, true);
      assert.equal(options.cfg.routing, "queue");
      calls.push({ type: "client", id });
    }
    dispose() {
      calls.push({ type: "dispose" });
    }
    register() {
      assert.fail("Recovery adapter owns registration");
    }
  }
  replace("../src/queue-client", { QueueClient: Client });
  replace("../src/queue-instance", { buildHash: () => "pinned-build" });
  const action = async (
    client: unknown,
    name: string,
    options: unknown,
    buildHash: string,
  ) => {
    assert.ok(client instanceof Client);
    calls.push({ type: "action", name, options, buildHash });
    return { status: "complete" };
  };
  replace("../src/queue-audit-facts-capture", { auditFactsAction: action });
  replace("../src/queue-scratch-control", { scratchEpochAction: action });
  replace("../src/queue-closed-epoch-successor", {
    prepareClosedSuccessor(
      client: unknown,
      options: unknown,
      buildHash: string,
    ) {
      return action(client, "authorize-closed-successor", options, buildHash);
    },
  });
  replace("../src/queue-native-fixture-grant", {
    nativeFixtureAction(client: unknown, options: unknown, buildHash: string) {
      return action(client, "grant-native-fixture", options, buildHash);
    },
  });
  replace("../src/queue-saved-fixture-control", { savedFixtureAction: action });
  replace("../src/queue-epoch-successor", {
    bootstrapSuccessor(
      client: unknown,
      cfg: { backend: string },
      options: unknown,
    ) {
      assert.equal(cfg.backend, "addin");
      return action(client, "successor-epoch", options, "pinned-build");
    },
    observeSuccessor(client: unknown, options: unknown, buildHash: string) {
      return action(client, "observe-successor", options, buildHash);
    },
  });
  const { queueCommand, descriptors } = runtimeRequire(entry) as {
    queueCommand(
      argv: string[],
      dependencies: Record<string, unknown>,
    ): Promise<number>;
    descriptors: Record<string, unknown>;
  };
  const exact = [
    "--job",
    "holder",
    "--observation-job",
    "observer",
    "--request-id",
    "stable-id",
  ];
  const cases: [string, string[], Record<string, unknown>][] = [
    [
      "capture-audit-facts",
      [...exact, "--confirm-read-only", "true"],
      {
        jobId: "holder",
        observationJobId: "observer",
        requestId: "stable-id",
        confirmReadOnly: true,
      },
    ],
    [
      "authorize-isolated-scratch",
      [
        "--request-id",
        "stable-id",
        "--facts-approval",
        "/approval.json",
        "--confirm-current-facts",
        "true",
      ],
      {
        requestId: "stable-id",
        approval: "/approval.json",
        confirmCurrentFacts: true,
      },
    ],
    [
      "create-isolated-scratch",
      exact,
      { jobId: "holder", observationJobId: "observer", requestId: "stable-id" },
    ],
    [
      "close-isolated-scratch",
      exact,
      { jobId: "holder", observationJobId: "observer", requestId: "stable-id" },
    ],
    [
      "close-isolated-scratch",
      [
        ...exact,
        "--admission-mode",
        "normal-multidocument",
        "--confirm-ownership",
        "true",
      ],
      {
        jobId: "holder",
        observationJobId: "observer",
        requestId: "stable-id",
        admissionMode: "normal-multidocument",
      },
    ],
    [
      "grant-isolated-scratch",
      ["--epoch-id", "epoch", "--grant-client", "native"],
      { epochId: "epoch", grantClientId: "native" },
    ],
    [
      "successor-epoch",
      [
        "--request-id",
        "stable-id",
        "--succession-approval",
        "/approval.json",
        "--preflight",
        "true",
      ],
      {
        approval: "/approval.json",
        requestId: "stable-id",
        preflight: true,
        confirmOwnership: false,
      },
    ],
    [
      "observe-successor",
      exact,
      { jobId: "holder", observationJobId: "observer", requestId: "stable-id" },
    ],
    [
      "authorize-closed-successor",
      [
        "--request-id",
        "stable-id",
        "--succession-approval",
        "/approval.json",
        "--confirm-ownership",
        "true",
      ],
      { approval: "/approval.json", requestId: "stable-id" },
    ],
    [
      "grant-native-fixture",
      [
        "--epoch-id",
        "epoch",
        "--grant-client",
        "native",
        "--fixture-id",
        "regional-geometry-v1",
        "--request-id",
        "stable-id",
        "--confirm-ownership",
        "true",
      ],
      {
        epochId: "epoch",
        grantClientId: "native",
        fixtureId: "regional-geometry-v1",
        requestId: "stable-id",
      },
    ],
    [
      "probe-saved-destination",
      [
        "--epoch-id",
        "epoch",
        "--job",
        "ready-job",
        "--request-id",
        "stable-id",
        "--authority-file",
        "/authority.json",
        "--folder-proof-file",
        "/folder.json",
        "--confirm-ownership",
        "true",
      ],
      {
        epochId: "epoch",
        requestId: "stable-id",
        jobId: "ready-job",
        authorityFile: "/authority.json",
        folderProofFile: "/folder.json",
      },
    ],
    [
      "grant-saved-first-save",
      [
        "--epoch-id",
        "epoch",
        "--grant-client",
        "native",
        "--request-id",
        "stable-id",
        "--save-request-id",
        "one-save",
        "--authority-file",
        "/authority.json",
        "--folder-proof-file",
        "/folder.json",
        "--confirm-ownership",
        "true",
      ],
      {
        epochId: "epoch",
        requestId: "stable-id",
        grantClientId: "native",
        saveRequestId: "one-save",
        authorityFile: "/authority.json",
        folderProofFile: "/folder.json",
      },
    ],
    [
      "observe-saved-first-save",
      [
        "--epoch-id",
        "epoch",
        "--job",
        "save-job",
        "--request-id",
        "stable-id",
        "--confirm-ownership",
        "true",
      ],
      { epochId: "epoch", requestId: "stable-id", jobId: "save-job" },
    ],
    [
      "retain-saved-fixture",
      [
        "--epoch-id",
        "epoch",
        "--job",
        "save-job",
        "--request-id",
        "stable-id",
        "--confirm-ownership",
        "true",
      ],
      { epochId: "epoch", requestId: "stable-id", jobId: "save-job" },
    ],
  ];
  for (const [name, flags, expected] of cases) {
    assert.ok(descriptors[name]);
    const output: string[] = [];
    assert.equal(
      await queueCommand([name, ...flags], {
        loadConfig: () => ({ cfg: { backend: "addin", queue: {} } }),
        stdout: { write: (text: string) => output.push(text) },
        stderr: { write: () => assert.fail("No child execution") },
      }),
      0,
    );
    assert.deepEqual(calls.splice(0), [
      { type: "client", id: process.env["FMCAD_CLIENT"] },
      { type: "action", name, options: expected, buildHash: "pinned-build" },
      { type: "dispose" },
    ]);
    assert.deepEqual(JSON.parse(output.join("")), { status: "complete" });
    for (const extra of [
      ["--client", "foreign"],
      ["--", "doc", "list"],
    ]) {
      await assert.rejects(
        queueCommand([name, ...flags, ...extra], {
          loadConfig() {
            assert.fail("Reject overrides before loading credentials");
          },
        }),
      );
    }
  }
});

test("normal read-attempt CLI obtains fresh SDK0 control and rejects request or approval overrides", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "normal-retry-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = new Map<string, NodeModule | undefined>();
  const replace = (name: string, exports: unknown) => {
    const file = runtimeRequire.resolve(name);
    saved.set(file, runtimeRequire.cache[file]);
    const module = new Module(file);
    module.exports = exports;
    module.filename = file;
    module.loaded = true;
    runtimeRequire.cache[file] = module;
  };
  const entry = runtimeRequire.resolve("../src/dist/entrypoints/queue-cli.js");
  saved.set(entry, runtimeRequire.cache[entry]);
  delete runtimeRequire.cache[entry];
  t.after(() => {
    for (const [file, original] of saved) {
      if (original) runtimeRequire.cache[file] = original;
      else delete runtimeRequire.cache[file];
    }
  });
  const calls: unknown[] = [];
  const summary = { control: { activeOperations: 0, activeIds: [] }, marker: "fresh authenticated broker summary" };
  class Client {
    constructor(_id: unknown, options: { existingCredentialsOnly: boolean }) {
      assert.equal(options.existingCredentialsOnly, true);
    }
    async call(action: string) { assert.equal(action, "queue-summary"); calls.push("summary"); return summary; }
    dispose() {}
    register() { assert.fail("No new credentials or SDK submission"); }
  }
  replace("../src/queue-client", { QueueClient: Client });
  replace("../src/queue-instance", { buildHash: () => "operator-build" });
  replace("../src/dist/composition/queue-normal-cold-successor", {
    authorizeNormalCurrentFactsRetry(client: unknown, evidence: unknown, candidate: unknown) {
      assert.ok(client instanceof Client); calls.push({ evidence, candidate }); return { authorized: true };
    },
    retireNormalCurrentFactsRetryProducer(client: unknown, reference: { path: string }, apply: boolean) {
      assert.ok(client instanceof Client); calls.push({ path: reference.path, apply }); return { retired: apply };
    },
  });
  const { queueCommand } = runtimeRequire(entry) as {
    queueCommand(argv: string[], dependencies: Record<string, unknown>): Promise<number>;
  };
  const dependencies = { loadConfig: () => ({ cfg: { backend: "mcp", queue: {} } }),
    stdout: { write() {} }, stderr: { write() { assert.fail("No child or SDK execution"); } } };
  const reference = { path: "/immutable-prior.json", sha256: "a".repeat(64) };
  const evidence = { previousRequestId: "previous-normal-read-scope", previousAuthority: reference, physicalResult: reference, validationFailure: reference };
  const candidate = { requestId: "fresh-normal-read" };
  const approval = path.join(root, "approval.json");
  const grant = path.join(root, "grant.json");
  fs.writeFileSync(approval, JSON.stringify({ evidence, candidate }));
  fs.writeFileSync(grant, JSON.stringify({ candidate }));
  const flags = ["--request-id", candidate.requestId, "--confirm-ownership", "true"];
  const authorize = ["authorize-normal-currentfacts-retry", ...flags, "--normal-read-attempt-approval", approval];
  assert.equal(await queueCommand(authorize, dependencies), 0);
  assert.deepEqual(calls.splice(0), ["summary", { evidence: { ...evidence, queueSummary: summary }, candidate }]);
  assert.equal(await queueCommand(["retire-normal-currentfacts-producer", ...flags, "--normal-read-attempt", grant], dependencies), 0);
  assert.deepEqual(calls.splice(0), [{ path: grant, apply: false }]);
  assert.equal(await queueCommand(["retire-normal-currentfacts-producer", ...flags, "--normal-read-attempt", grant, "--apply", "true"], dependencies), 0);
  assert.deepEqual(calls.splice(0), [{ path: grant, apply: true }]);
  fs.writeFileSync(approval, JSON.stringify({ evidence: { ...evidence, queueSummary: summary }, candidate }));
  await assert.rejects(queueCommand(authorize, dependencies), /caller-supplied queue summary/);
  fs.writeFileSync(approval, JSON.stringify({ evidence, candidate: { requestId: "foreign" } }));
  await assert.rejects(queueCommand(authorize, dependencies), /Exact fresh normal read request/);
  fs.writeFileSync(grant, JSON.stringify({ candidate: { requestId: "foreign" } }));
  await assert.rejects(queueCommand(["retire-normal-currentfacts-producer", ...flags, "--normal-read-attempt", grant], dependencies), /request differs/);
  assert.deepEqual(calls, []);
  for (const extra of [["--client", "foreign"], ["--apply", "false"], ["--normal-target", approval], ["--", "doc", "list"]]) {
    await assert.rejects(queueCommand([...authorize, ...extra], {
      loadConfig() { assert.fail("Reject overrides before loading credentials"); },
    }));
  }
});
