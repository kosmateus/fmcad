import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
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
