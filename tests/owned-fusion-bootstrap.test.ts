import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  createOwnedFusionBootstrap,
  type OwnedFusionBootstrapPorts,
} from "../src/owned-fusion-bootstrap";
import {
  controlledFusionBootstrapFixture,
  controlledStartupAuditFixture,
} from "./controlled-fusion-bootstrap-fixture";
import type { OwnedAutoloadLaunch } from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";
import type { BootstrapOwnedEntryIntentV3 } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { bootstrapProfileSemanticDigest } from "../packages/node-adapters/src/execution/bootstrap-profile-digest";
import { createOwnedControlledStdoutProvider } from "../src/controlled-stdout-provider";
import { prepareControlledBootstrapOriginals } from "../src/fresh-host-proof";
import { compilePythonStdout } from "../src/python-diagnostic-broker";
import type { NativeRuntimeRebaselineReaderPorts } from "../packages/node-adapters/src/execution/runtime-rebaseline-reader";
import type {
  NativeRuntimeActivationPublication,
  NativeRuntimeActivationCompletion,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
const load = createRequire(__filename);
const { planOwnedBootstrapAutoload } = load(
  "../src/dist/node-adapters/execution/fusion-bootstrap-autoload",
) as typeof import("../packages/node-adapters/src/execution/fusion-bootstrap-autoload");
const { ControlledFusionNativeError } = load(
  "../src/dist/node-adapters/execution/controlled-fusion-launch",
) as typeof import("../packages/node-adapters/src/execution/controlled-fusion-launch");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const ref = (file: {
  nativePath: string;
  sha256: string;
  identity: string;
}) => ({
  nativePath: file.nativePath,
  sha256: file.sha256,
  identity: file.identity,
});

function fixture(
  fault?:
    | "journal"
    | "cold"
    | "generation"
    | "foreign-startup"
    | "native-unknown"
    | "vendor-format"
    | "lease",
) {
  const f = controlledFusionBootstrapFixture({ captureStartupInputs: true });
  const native = f.native;
  const lifecycle = {
    handoffId: "original-committed-handoff",
    generation: { instance: "owned-instance", epoch: "owned-epoch" },
    database: {
      nativePath: "C:\\fixture\\native.db",
      identity: "original-db-identity",
    },
    handoffRequest: {
      nativePath: "C:\\fixture\\handoff-request.json",
      sha256: "1".repeat(64),
    },
    handoffReceipt: {
      nativePath: "C:\\fixture\\handoff-receipt.json",
      sha256: "2".repeat(64),
    },
  };
  native.awaitReceipts = async (process) => {
    assert.deepEqual(process, f.fresh);
    f.events.push("owned-receipts");
    const original = f.files.get(native.paths.intent)!;
    const intent: BootstrapOwnedEntryIntentV3 = JSON.parse(
      Buffer.from(original.bytes).toString(),
    );
    if (fault === "vendor-format") {
      const current = f.files.get(native.paths.profile)!;
      f.file(
        native.paths.profile,
        Buffer.from(
          JSON.stringify(
            JSON.parse(Buffer.from(current.bytes).toString()),
            null,
            "\t",
          ).replaceAll("\n", "\r\n"),
        ),
      );
    }
    const audit = controlledStartupAuditFixture();
    audit.scripts.items[0]!.folder = native.installedDirectory;
    audit.scripts.items[0]!.isRunOnStartup = true;
    audit.scripts.items[0]!.isRunning = true;
    if (fault === "foreign-startup") {
      audit.scripts.items[1]!.isAddIn = true;
      audit.scripts.items[1]!.isRunOnStartup = true;
    }
    const base = {
      kind: "fmcad-bootstrap-entry-receipt",
      version: 3,
      mode: intent.mode,
      nonce: intent.nonce,
      process,
      purpose: intent.purpose,
      engineVersion: 2,
      generation: intent.generation,
      provision: intent.provision,
      executable: intent.executable,
      intent: { path: original.nativePath, sha256: original.sha256 },
      profile: intent.profile,
      installed: {
        directory: native.installedDirectory,
        source: native.installedSource,
        filesDigest: native.installedBuild,
      },
    };
    const entry = f.file(
      native.paths.entry,
      encode({
        ...base,
        phase: "entry-audited-before-addon-import",
        startupAudit: audit,
      }),
    );
    const returned = f.file(
      native.paths.returned,
      encode({
        ...base,
        phase: "run-returned",
        entry: { path: entry.nativePath, sha256: entry.sha256 },
      }),
    );
    return { entry, returned };
  };
  const ports: OwnedFusionBootstrapPorts = {
    native,
    lifecycle,
    acquireExclusiveLifecycleLease:
      fault === "lease"
        ? async () => {
            throw new Error("Original lifecycle acquisition denied");
          }
        : f.ports.acquireExclusiveLifecycleLease,
    qualifyNativeInstallationAfterDeath:
      f.ports.qualifyNativeInstallationAfterDeath,
    async prepareBeforeLaunch({ lease }) {
      assert.ok(f.startupInputs);
      const startupInputs = f.startupInputs;
      const discovery = f.file(
        "C:\\fixture\\discovery-original.json",
        encode({ originalRoots: ["C:\\fixture"] }),
      );
      return {
        startupInputs,
        discoveryOriginals: [discovery],
        fence: () => lease.fence(),
        assertCurrent: () => lease.assertCurrent(),
        async launchAfterDeath(old, nonce): Promise<OwnedAutoloadLaunch> {
          f.events.push("owned-launch");
          if (fault === "native-unknown")
            throw new ControlledFusionNativeError(
              "owned-autoload-launch",
              "",
              '{"createdProcess":{"pid":2,"birth":"new-suspended"}}',
            );
          const original = await native.readProfileAfterDeath(old);
          const plan = planOwnedBootstrapAutoload(
            original.bytes,
            native.installedDirectory + "\\AutodeskFusionMCP.py",
          );
          const applied = await native.applyProfileAfterDeath(
            old,
            original,
            plan.registrationBytes(),
          );
          const sourceClosure = f.file(native.paths.sourceClosure);
          const executable = {
            path: "C:\\Fusion\\Fusion.exe",
            sha256: "f".repeat(64),
          };
          const attempt = f.file(
            native.paths.launchAttempt,
            encode({
              kind: "owned-autoload-launch-attempt-v1",
              isolation: "NOT_PROVEN",
              nonce,
              old,
              executable: executable.path,
              executableSha256: executable.sha256,
              profile: {
                ...ref(applied.profile),
                base64: Buffer.from(applied.profile.bytes).toString("base64"),
              },
              sourceClosure: ref(sourceClosure),
            }),
          );
          const journal = f.file(
            native.paths.launchJournal,
            encode({
              kind: "owned-autoload-created-process-v1",
              nonce,
              process: f.fresh,
              executable: executable.path,
              executableSha256:
                fault === "journal" ? "0".repeat(64) : executable.sha256,
              attempt: ref(attempt),
              threadId: 10,
              phase: "created-suspended",
              isolation: "NOT_PROVEN",
            }),
          );
          const coldProcess = f.file(
            "C:\\fixture\\cold.json",
            encode({
              ...f.fresh,
              ...(fault === "cold" ? { pid: 999 } : {}),
              exe: executable.path,
              executableSha256: executable.sha256,
              nonce,
              phase: "created-suspended",
              isolation: "NOT_PROVEN",
            }),
          );
          const provisionBackup = f.file(
            "C:\\fixture\\provision-backup.json",
            encode({
              ...old,
              instance: "old-instance",
              epoch: "old-epoch",
              source: "7".repeat(40),
              build: "8".repeat(64),
            }),
          );
          const provision = f.file(
            native.paths.provision,
            encode({
              ...f.fresh,
              ...lifecycle.generation,
              source: "7".repeat(40),
              build: "8".repeat(64),
            }),
          );
          const provisionReceipt = f.file(
            "C:\\fixture\\provision-receipt.json",
            encode({
              kind: "owned-autoload-provision-bound-v1",
              isolation: "NOT_PROVEN",
              nonce,
              old,
              process: f.fresh,
              ...lifecycle,
              beforeSha256: provisionBackup.sha256,
              backup: ref(provisionBackup),
              after: ref(provision),
            }),
          );
          const expected: BootstrapOwnedEntryIntentV3 = {
            kind: "fmcad-bootstrap-entry-intent",
            version: 3,
            mode: "owned-autoload-v1",
            nonce,
            process: f.fresh,
            executable,
            purpose: "isolated-stdout-v1",
            engineVersion: 2,
            installed: {
              directory: native.installedDirectory,
              source: native.installedSource,
              files: native.installedFiles,
            },
            profile: {
              path: applied.profile.nativePath,
              sha256: applied.profile.sha256,
              semanticSha256: bootstrapProfileSemanticDigest(
                applied.profile.bytes,
              ),
            },
            provision: { path: provision.nativePath, sha256: provision.sha256 },
            generation:
              fault === "generation"
                ? { ...lifecycle.generation, epoch: "foreign" }
                : lifecycle.generation,
            receipts: {
              directory: native.paths.receiptDirectory,
              entry: "entry.json",
              returned: "returned.json",
            },
          };
          const intent = f.file(native.paths.intent, encode(expected));
          return {
            process: f.fresh,
            journal,
            attempt,
            sourceClosure,
            ...applied,
            profileBackup: applied.backup,
            provision,
            provisionBackup,
            provisionReceipt,
            coldProcess,
            intent,
            startupProven: false,
          };
        },
      };
    },
    async observeNativeRebound({ old, launch, qualifiedPackagePins }) {
      f.events.push("observe-owned-rebound");
      return f.ports.rebindNative({
        old,
        launched: launch,
        profile: launch.profile,
        qualifiedPackagePins,
      });
    },
  };
  return {
    ...f,
    lifecycle,
    owned: createOwnedFusionBootstrap(f.old, ports),
    readOwnedStartupInputs() {
      assert.ok(f.startupInputs);
      return f.startupInputs;
    },
  };
}

test("owned controller accepts receipt binding after post-resume vendor formatting with original raw provenance", async () => {
  const f = fixture("vendor-format");
  const transcript = await f.owned.run();
  assert.equal(transcript.state, "COMPLETED", transcript.error ?? "");
  const intent: BootstrapOwnedEntryIntentV3 = JSON.parse(
    Buffer.from(f.files.get(f.native.paths.intent)!.bytes).toString(),
  );
  const current = f.files.get(f.native.paths.profile)!;
  assert.notEqual(
    createHash("sha256").update(current.bytes).digest("hex"),
    intent.profile.sha256,
  );
  assert.equal(
    bootstrapProfileSemanticDigest(current.bytes),
    intent.profile.semanticSha256,
  );
  const witness = await f.owned.prepareOriginalWitness(transcript);
  assert(
    !witness.context.originalRefs.some(
      (reference) => reference.nativePath === f.native.paths.profile,
    ),
  );
  witness.fence();
  const changed = JSON.parse(Buffer.from(current.bytes).toString());
  changed.loadedScripts[0].isFavorite = !changed.loadedScripts[0].isFavorite;
  f.file(f.native.paths.profile, encode(changed));
  await assert.rejects(
    f.owned.assertOriginalTranscript(transcript),
    /semantic profile/,
  );
});

test("owned original controller composes through MAC-reference port and provider to the real compiler without SDK execution", async () => {
  const f = fixture();
  const transcript = await f.owned.run();
  assert.equal(transcript.state, "COMPLETED", transcript.error ?? "");
  const startupInputs = f.readOwnedStartupInputs();
  const originals = await prepareControlledBootstrapOriginals(
    f.owned,
    transcript,
    startupInputs,
  );
  const refs = originals.readCurrentReferences();
  assert.equal(
    new Set(refs.map((ref) => path.win32.normalize(ref.path).toLowerCase()))
      .size,
    refs.length,
    "actual owned controller and startup roles must produce native-consumable unique references",
  );
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const compilerPins = {
    buildHash: digest("broker"),
    configHash: digest("config"),
    generation: "compiler",
  };
  const descriptor = {
    kind: "fmcad-physical-grant" as const,
    version: 1 as const,
    handoffId: f.lifecycle.handoffId,
    generation: f.lifecycle.generation,
    brokerOwner: {
      pid: 7,
      birth: "broker-birth",
      nonce: "owner",
      clientId: "fixture",
      queueDirectory: "/fixture",
    },
    endpointURL: "http://127.0.0.1:8765/mcp",
    physicalRuntime: {
      ...f.fresh,
      version: "2.0.0 fixture",
      source: "7".repeat(40),
      build: "8".repeat(64),
    },
  };
  const publication: NativeRuntimeActivationPublication = {
    store: "/fixture",
    storeDevice: 1,
    storeInode: 2,
    expectedHead: "old",
    expectedFiles: {},
    activationFile: "/activation",
    activationBytes: "original",
    record: { path: "/record", sha256: "record" },
  };
  const completion: NativeRuntimeActivationCompletion = {
    binding: {
      requestId: "binding",
      newHead: "new",
      publicationDigest: "publication",
      initiatorOperatorId: "operator",
    },
    evidence: [],
    nativeReceipt: {
      kind: "native-runtime-rebaseline-consume-v1",
      reference: { path: "/receipt", sha256: "receipt" },
    },
  };
  let reads = 0;
  const provider = createOwnedControlledStdoutProvider(
    {
      controller: f.owned,
      transcript,
      startupInputs,
      assertBootstrapHeld: originals.assertCurrent,
      readCurrentHost: () => ({
        descriptor,
        brokerBuild: compilerPins.buildHash,
        brokerConfig: compilerPins.configHash,
        purpose: "isolated-stdout-v1",
        engineVersion: 2,
      }),
      createReader() {
        const reader: NativeRuntimeRebaselineReaderPorts = {
          store: "/fixture",
          pins: {
            handoffId: descriptor.handoffId,
            generation: descriptor.generation,
            process: f.fresh,
            source: descriptor.physicalRuntime.source,
            build: descriptor.physicalRuntime.build,
            endpoint: descriptor.endpointURL,
            admissionStore: "/fixture",
          },
          invalidate() {},
          async verifyConsumed(p, c) {
            assert.deepEqual(p, publication);
            assert.deepEqual(c, completion);
            reads++;
            return {
              authenticatedCurrentPins: reader.pins,
              authenticatedIntentReferences: originals.readCurrentReferences(),
              finalize() {},
              abort() {},
            };
          },
          async getVerifiedActivation() {
            return {
              requestId: "binding",
              newHead: "new",
              publicationDigest: "publication",
              fenceNonce: "fence",
              receiptDigest: "receipt",
            };
          },
        };
        return reader;
      },
    },
    publication,
    completion,
  );
  const request = {
    kind: "rpc" as const,
    backend: "addin",
    clientId: "fixture",
    requestId: "request",
    timeoutMs: 45000,
    ownerToken: "a".repeat(64),
    payload: {
      jsonrpc: "2.0",
      id: "original",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: "print('owned')", persistent: false },
      },
    },
  };
  const compiled = await compilePythonStdout(
    request,
    await provider(request, compilerPins),
  );
  assert.ok(compiled);
  compiled.assertWire(
    request,
    { ...compiled.rpc(), id: "fmcad:owned" },
    "owned",
  );
  assert.equal(reads, 1);
  f.revoke();
  assert.throws(() => compiled.reverify(request), /revoked/);
});

for (const failure of ["unacquired", "revoked"] as const) {
  test(`owned UNKNOWN stays local when lifecycle lease is ${failure}`, async () => {
    const f = fixture(failure === "unacquired" ? "lease" : undefined);
    if (failure === "revoked") f.revoke();
    let publications = 0;
    f.native.publishOriginal = async () => {
      publications++;
      throw new Error("Native publication must not start without held lease");
    };
    const result = await f.owned.run();
    assert.equal(result.state, "UNKNOWN");
    assert.equal(publications, 0);
    await assert.rejects(f.owned.run(), /replayed/);
  });
}

test("owned UNKNOWN can retain one native transcript while the original lifecycle lease remains held", async () => {
  const f = fixture("journal");
  const publish = f.native.publishOriginal;
  let publications = 0;
  f.native.publishOriginal = async (name, bytes) => {
    publications++;
    return publish(name, bytes);
  };
  const result = await f.owned.run();
  assert.equal(result.state, "UNKNOWN");
  assert.equal(publications, 1);
  assert.equal(f.files.has(f.native.paths.transcript), true);
  await assert.rejects(f.owned.run(), /replayed/);
});

test("owned controller preserves original pre-resume chain and never calls the manual UI path", async () => {
  const f = fixture();
  const result = await f.owned.run();
  assert.equal(result.state, "COMPLETED", result.error ?? "");
  assert.equal(result.authority, "NONE");
  assert.ok(
    f.events.indexOf("owned-launch") < f.events.indexOf("owned-receipts"),
  );
  assert.ok(
    f.events.indexOf("owned-receipts") <
      f.events.indexOf("observe-owned-rebound"),
  );
  assert.equal(f.events.includes("prepare-ui"), false);
  assert.equal(f.events.includes("start-once"), false);
  const intent = await f.owned.readOriginalIntent(result);
  assert.equal(intent.version, 3);
  assert.equal(
    (await f.owned.readOriginalEvidence(result)).provision.nativePath,
    f.native.paths.provision,
  );
  const witness = await f.owned.prepareOriginalWitness(result);
  f.owned.assertPreparedWitness(witness);
  await assert.rejects(
    f.owned.readOriginalIntent(structuredClone(result)),
    /Original owned/,
  );
  assert.throws(() => f.owned.assertPreparedWitness({ ...witness }), /Foreign/);
  f.revoke();
  assert.throws(witness.fence, /revoked/);
  await assert.rejects(f.owned.run(), /replayed/);
});
for (const fault of [
  "journal",
  "cold",
  "generation",
  "foreign-startup",
  "native-unknown",
] as const)
  test(`owned controller preserves UNKNOWN without fallback or replay for ${fault}`, async () => {
    const f = fixture(fault);
    const result = await f.owned.run();
    assert.equal(result.state, "UNKNOWN");
    assert.equal(
      f.events.filter((event) => event === "owned-launch").length,
      1,
    );
    assert.equal(f.events.includes("observe-owned-rebound"), false);
    assert.equal(f.events.includes("prepare-ui"), false);
    if (fault === "native-unknown")
      assert.match(result.error ?? "", /new-suspended/);
    await assert.rejects(
      f.owned.prepareOriginalWitness(result),
      /Original owned/,
    );
    await assert.rejects(f.owned.run(), /replayed/);
  });
