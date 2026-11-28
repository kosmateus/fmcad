import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  createFreshHostProofFactory,
  createControlledHostProofFactory,
  createOwnedControlledHostProofFactory,
  type OwnedControlledHostProofPorts,
  type FreshHostContext,
  type ControlledHostProofPorts,
  type ControlledHostPreparationContext,
  prepareControlledBootstrapOriginals,
} from "../src/fresh-host-proof";
import {
  bootstrapInstalledFilesDigest,
  type BootstrapEntryIntentV2,
  type BootstrapOwnedEntryIntentV3,
} from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { controlledStartupAuditFixture } from "./controlled-fusion-bootstrap-fixture";
import type { ControlledFusionBootstrapTranscript } from "../src/controlled-fusion-bootstrap";
import {
  createControlledStdoutProvider,
  createOwnedControlledStdoutProvider,
} from "../src/controlled-stdout-provider";
import {
  compilePythonStdout,
  pythonStdoutInputDigests,
} from "../src/python-diagnostic-broker";
import type {
  NativeRuntimeActivationCompletion,
  NativeRuntimeActivationPublication,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import type { FreshHostProofPorts } from "../src/fresh-host-proof";

function fixture() {
  const current: FreshHostContext = {
    descriptor: {
      kind: "fmcad-physical-grant",
      version: 1,
      handoffId: "handoff",
      generation: { epoch: "epoch", instance: "instance" },
      brokerOwner: {
        pid: 1,
        birth: "broker-birth",
        nonce: "nonce",
        clientId: "client",
        queueDirectory: "/queue",
      },
      endpointURL: "http://localhost:8765",
      physicalRuntime: {
        pid: 2,
        birth: "fusion-birth",
        version: "version",
        source: "source",
        build: "build",
      },
    },
    brokerBuild: "broker-build",
    brokerConfig: "config",
    requestId: "request",
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
    kernelDigest: "kernel",
    programDigest: "program",
    wireDigest: "wire",
  };
  const publication: NativeRuntimeActivationPublication = {
    store: "/store",
    storeDevice: 1,
    storeInode: 2,
    expectedHead: "head",
    expectedFiles: {},
    activationFile: "/activation",
    activationBytes: "original",
    record: { path: "/record", sha256: "record-sha" },
  };
  const completion: NativeRuntimeActivationCompletion = {
    binding: {
      requestId: "original-request",
      newHead: "new-head",
      publicationDigest: "publication",
      initiatorOperatorId: "operator",
    },
    evidence: [],
    nativeReceipt: {
      kind: "native-runtime-rebaseline-consume-v1",
      reference: { path: "/receipt", sha256: "receipt-sha" },
    },
  };
  let calls = 0;
  let held = true;
  let active = true;
  let nativeError: Error | undefined;
  let duringVerify = () => {};
  let duringActivation = () => {};
  const ports: FreshHostProofPorts = {
    assertBootstrapHeld() {
      assert.ok(held, "BOOTSTRAP_LEASE_REVOKED");
    },
    readCurrent: () => structuredClone(current),
    reader: {
      store: "/store",
      pins: {
        handoffId: "handoff",
        admissionStore: "/store",
        generation: structuredClone(current.descriptor.generation),
        process: { pid: 2, birth: "fusion-birth" },
        source: "source",
        build: "build",
        endpoint: current.descriptor.endpointURL,
      },
      invalidate() {
        active = false;
      },
      async verifyConsumed(p, c) {
        calls++;
        assert.equal(p.activationBytes, "original");
        assert.equal(c.nativeReceipt.reference.path, "/receipt");
        if (nativeError) throw nativeError;
        duringVerify();
        return {
          authenticatedCurrentPins: structuredClone(ports.reader.pins),
          finalize() {},
          abort() {},
        };
      },
      async getVerifiedActivation() {
        duringActivation();
        return active
          ? {
              requestId: "original-request",
              fenceNonce: "fence",
              newHead: "new-head",
              publicationDigest: "publication",
              receiptDigest: "receipt",
            }
          : undefined;
      },
    },
  };
  const factory = createFreshHostProofFactory(
    ports,
    current,
    publication,
    completion,
  );
  return {
    factory,
    ports,
    current,
    publication,
    completion,
    calls: () => calls,
    loseLease: () => (held = false),
    loseGrant: () => (active = false),
    failNative: (error: Error) => (nativeError = error),
    duringVerify: (run: () => void) => (duringVerify = run),
    duringActivation: (run: () => void) => (duringActivation = run),
  };
}

async function controlledFixture(options: { autorunRoot?: string } = {}) {
  const f = fixture();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
  const file = (nativePath: string, value: unknown) => {
    const bytes = encode(value);
    return {
      nativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: `owned:${nativePath}`,
    };
  };
  const fork = "C:\\private\\addin\\AutodeskFusionMCP.py";
  const profile = file("C:\\private\\profile\\JSLoadedScriptsinfo", {
    loadedScripts: [
      {
        name: "AutodeskFusionMCP",
        path: fork,
        location: 3,
        isRemoved: false,
        isFavorite: false,
        runOnStartup: false,
      },
    ],
  });
  const executable = {
    path: "C:\\Program Files\\Autodesk\\Fusion\\Fusion.exe",
    sha256: "f".repeat(64),
  };
  const startupAudit = controlledStartupAuditFixture();
  startupAudit.scripts.items[0]!.folder = "C:\\private\\addin";
  const expected: BootstrapEntryIntentV2 = {
    kind: "fmcad-bootstrap-entry-intent",
    version: 2,
    nonce: "a".repeat(32),
    process: { pid: 2, birth: "fusion-birth" },
    executable,
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
    installed: {
      directory: "C:\\private\\addin",
      source: "b".repeat(40),
      files: {
        "AutodeskFusionMCP.py": "c".repeat(64),
        "addon_runtime.py": "d".repeat(64),
        "lib/bootstrap_entry.py": "e".repeat(64),
        "AutodeskFusionMCP.manifest":
          startupAudit.scripts.items[0]!.manifest.sha256,
      },
    },
    profile: { path: profile.nativePath, sha256: profile.sha256 },
    receipts: {
      directory: "C:\\private\\receipts",
      entry: "entry.json",
      returned: "returned.json",
    },
  };
  const intent = file("C:\\private\\intent.json", expected);
  const reference = (value: { nativePath: string; sha256: string }) => ({
    path: value.nativePath,
    sha256: value.sha256,
  });
  const base = {
    kind: "fmcad-bootstrap-entry-receipt",
    version: 2,
    nonce: expected.nonce,
    process: expected.process,
    purpose: expected.purpose,
    engineVersion: 2,
    executable,
    intent: reference(intent),
    profile: expected.profile,
    installed: {
      directory: expected.installed.directory,
      source: expected.installed.source,
      filesDigest: bootstrapInstalledFilesDigest(expected.installed.files),
    },
  };
  const entry = file("C:\\private\\receipts\\entry.json", {
    ...base,
    phase: "entry-audited-before-addon-import",
    startupAudit,
  });
  const returned = file("C:\\private\\receipts\\returned.json", {
    ...base,
    phase: "run-returned",
    entry: reference(entry),
  });
  const sourceClosure = file("C:\\private\\source-closure.json", {});
  const launchAttempt = file("C:\\private\\launch-attempt.json", {
    kind: "controlled-launch-attempt-v1",
    nonce: expected.nonce,
    old: { pid: 1, birth: "old-birth" },
    executable: executable.path,
    executableSha256: executable.sha256,
    profile: {
      nativePath: profile.nativePath,
      sha256: profile.sha256,
      identity: profile.identity,
    },
    sourceClosure: {
      nativePath: sourceClosure.nativePath,
      sha256: sourceClosure.sha256,
      identity: sourceClosure.identity,
    },
  });
  const launchJournal = file("C:\\private\\launch-journal.json", {
    kind: "controlled-created-process-v1",
    nonce: expected.nonce,
    process: expected.process,
    executable: executable.path,
    executableSha256: executable.sha256,
    attempt: {
      nativePath: launchAttempt.nativePath,
      sha256: launchAttempt.sha256,
      identity: launchAttempt.identity,
    },
  });
  const transcript: ControlledFusionBootstrapTranscript = {
    kind: "controlled-fusion-bootstrap-transcript-v1",
    authority: "NONE",
    state: "COMPLETED",
    nonce: expected.nonce,
    old: { pid: 1, birth: "old-birth" },
    process: expected.process,
    phases: ["fixture"],
    references: [],
    error: null,
  };
  const transcriptFile = file("C:\\private\\transcript.json", transcript);
  const files = [
    intent,
    profile,
    entry,
    returned,
    sourceClosure,
    launchAttempt,
    launchJournal,
    transcriptFile,
  ];
  const autorunRoot = options.autorunRoot ?? "C:\\private";
  const autorunFiles = [
    file(`${autorunRoot}\\PythonAutorunModuleinfo`, {
      enabledModules: [],
      lastAppInstallTime: 0,
    }),
    file(`${autorunRoot}\\profile\\PythonAutorunModuleinfo`, {
      enabledModules: [],
      lastAppInstallTime: 0,
    }),
  ];
  const context = {
    nonce: expected.nonce,
    process: expected.process,
    installedDirectory: expected.installed.directory,
    installedSource: expected.installed.source,
    installedBuild: base.installed.filesDigest,
    nativePathMappings: Object.fromEntries(
      [...files, ...autorunFiles].map((file, i) => [
        file.nativePath,
        `/original/${i}`,
      ]),
    ),
    originalRefs: files.map(({ nativePath, sha256, identity }) => ({
      nativePath,
      sha256,
      identity,
    })),
  };
  f.current.descriptor.physicalRuntime.source = context.installedSource;
  f.current.descriptor.physicalRuntime.build = context.installedBuild;
  f.ports.reader.pins.source = context.installedSource;
  f.ports.reader.pins.build = context.installedBuild;
  let windowHeld = true;
  let startupChanged = false;
  const assertStartupOriginal = (original: {
    nativePath: string;
    sha256: string;
    identity: string;
  }) => {
    assert.ok(!startupChanged, "STARTUP_INPUT_REPLACED");
    const actual = autorunFiles.find(
      (value) => value.nativePath === original.nativePath,
    );
    assert.ok(actual);
    assert.equal(actual.sha256, original.sha256);
    assert.equal(actual.identity, original.identity);
  };
  const { prepareControlledStartupInputs } = createRequire(__filename)(
    "../src/dist/node-adapters/execution/controlled-startup-inputs",
  ) as typeof import("../packages/node-adapters/src/execution/controlled-startup-inputs");
  const startupInputs = await prepareControlledStartupInputs({
    expected: {
      defaultApiParent: startupAudit.preferences.defaultPathForScriptsAndAddIns,
      installedDirectory: expected.installed.directory,
      installedManifestHash: startupAudit.scripts.items[0]!.manifest.sha256,
      autorunPaths: [autorunFiles[0]!.nativePath, autorunFiles[1]!.nativePath],
    },
    assertBeforeLaunch() {},
    assertHeld() {
      assert.ok(windowHeld, "CONTROLLED_WINDOW_REVOKED");
    },
    async assertHeldCurrent() {
      assert.ok(windowHeld, "CONTROLLED_WINDOW_REVOKED");
    },
    native: {
      async preflight() {
        assert.ok(!startupChanged, "STARTUP_INPUT_REPLACED");
      },
      async readOriginal(name) {
        const original = autorunFiles.find(
          (value) => value.nativePath === name,
        );
        assert.ok(original);
        return original;
      },
      async assertOriginal(original) {
        assertStartupOriginal(original);
      },
      captureSynchronousFence(originals) {
        return () => {
          for (const original of originals) assertStartupOriginal(original);
        };
      },
    },
  });
  const witness = {
    context,
    fence() {
      assert.ok(windowHeld, "CONTROLLED_WINDOW_REVOKED");
    },
  };
  const signed = [...files, ...autorunFiles].map((file) => ({
    path: context.nativePathMappings[file.nativePath]!,
    sha256: file.sha256,
  }));
  const verifyConsumed = f.ports.reader.verifyConsumed;
  f.ports.reader.verifyConsumed = async (publication, completion) => ({
    ...(await verifyConsumed(publication, completion)),
    authenticatedIntentReferences: signed,
  });
  const compilerPins = {
    buildHash: f.current.brokerBuild,
    configHash: f.current.brokerConfig,
    generation: "compiler-generation-not-native-epoch",
  };
  const preparationContext: ControlledHostPreparationContext = {
    descriptor: f.current.descriptor,
    brokerBuild: f.current.brokerBuild,
    brokerConfig: f.current.brokerConfig,
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
    originalRequestDigest: "1".repeat(64),
    originalLogicalRpcDigest: "2".repeat(64),
    sourceDigest: "3".repeat(64),
  };
  const ports: ControlledHostProofPorts = {
    ...f.ports,
    startupInputs,
    readCurrent: () => structuredClone(preparationContext),
    transcript,
    readCompilerPins: () => ({ ...compilerPins }),
    controller: {
      async prepareOriginalWitness(original) {
        assert.equal(original, transcript);
        witness.fence();
        return witness;
      },
      assertPreparedWitness(value) {
        assert.equal(value, witness);
        witness.fence();
      },
      async readOriginalIntent() {
        return structuredClone(expected);
      },
      async readOriginalEvidence() {
        return { intent, profile, entry, returned };
      },
      async readOriginalTranscriptReference() {
        return transcriptFile;
      },
    },
  };
  const factory = createControlledHostProofFactory(
    ports,
    preparationContext,
    f.publication,
    f.completion,
  );
  return {
    ...f,
    factory,
    signed,
    context,
    ports,
    compilerPins,
    preparationContext,
    startupInputs,
    autorunFiles,
    changeStartupInputs: (changed = true) => {
      startupChanged = changed;
    },
    changeAuditedPolicy(
      alter: (audit: ReturnType<typeof controlledStartupAuditFixture>) => void,
    ) {
      const updated = controlledStartupAuditFixture();
      updated.scripts.items[0]!.folder = expected.installed.directory;
      alter(updated);
      entry.bytes = encode({
        ...base,
        phase: "entry-audited-before-addon-import",
        startupAudit: updated,
      });
      entry.sha256 = createHash("sha256").update(entry.bytes).digest("hex");
      returned.bytes = encode({
        ...base,
        phase: "run-returned",
        entry: reference(entry),
      });
      returned.sha256 = createHash("sha256")
        .update(returned.bytes)
        .digest("hex");
      for (const updatedFile of [entry, returned]) {
        context.originalRefs.find(
          (ref) => ref.nativePath === updatedFile.nativePath,
        )!.sha256 = updatedFile.sha256;
        signed.find(
          (ref) =>
            ref.path === context.nativePathMappings[updatedFile.nativePath],
        )!.sha256 = updatedFile.sha256;
      }
    },
    loseWindow: () => (windowHeld = false),
  };
}

async function ownedControlledFixture(
  options: { runtimeSource?: string; runtimeBuild?: string } = {},
) {
  const f = await controlledFixture();
  const original = await f.ports.controller.readOriginalIntent(
    f.ports.transcript,
  );
  const evidence = await f.ports.controller.readOriginalEvidence(
    f.ports.transcript,
  );
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const profile = JSON.parse(Buffer.from(evidence.profile.bytes).toString());
  profile.loadedScripts[0].runOnStartup = true;
  evidence.profile.bytes = encode(profile);
  const generation = structuredClone(
    f.preparationContext.descriptor.generation,
  );
  const provision = {
    nativePath: "C:\\private\\provision.json",
    bytes: encode({
      ...original.process,
      ...generation,
      source: "7".repeat(40),
      build: "8".repeat(64),
    }),
  };
  const intent: BootstrapOwnedEntryIntentV3 = {
    ...original,
    version: 3,
    mode: "owned-autoload-v1",
    generation,
    provision: { path: provision.nativePath, sha256: hash(provision.bytes) },
    profile: { ...original.profile, sha256: hash(evidence.profile.bytes) },
  };
  evidence.intent.bytes = encode(intent);
  const extra = {
    version: 3,
    mode: intent.mode,
    generation,
    provision: intent.provision,
    profile: intent.profile,
    intent: {
      path: evidence.intent.nativePath,
      sha256: hash(evidence.intent.bytes),
    },
  };
  const entry = JSON.parse(Buffer.from(evidence.entry.bytes).toString());
  entry.startupAudit.scripts.items[0].isRunOnStartup = true;
  entry.startupAudit.scripts.items[0].isRunning = true;
  evidence.entry.bytes = encode({ ...entry, ...extra });
  const returned = JSON.parse(Buffer.from(evidence.returned.bytes).toString());
  evidence.returned.bytes = encode({
    ...returned,
    ...extra,
    entry: {
      path: evidence.entry.nativePath,
      sha256: hash(evidence.entry.bytes),
    },
  });
  for (const file of Object.values(evidence)) {
    const digest = hash(file.bytes);
    f.context.originalRefs.find(
      (ref) => ref.nativePath === file.nativePath,
    )!.sha256 = digest;
    f.signed.find(
      (ref) => ref.path === f.context.nativePathMappings[file.nativePath],
    )!.sha256 = digest;
  }
  f.context.nativePathMappings[provision.nativePath] = "/original/provision";
  f.context.originalRefs.push({
    nativePath: provision.nativePath,
    sha256: hash(provision.bytes),
    identity: "original-provision",
  });
  f.signed.push({ path: "/original/provision", sha256: hash(provision.bytes) });
  const runtimeSource = options.runtimeSource ?? "7".repeat(40);
  const runtimeBuild = options.runtimeBuild ?? "8".repeat(64);
  f.preparationContext.descriptor.physicalRuntime.source = runtimeSource;
  f.preparationContext.descriptor.physicalRuntime.build = runtimeBuild;
  f.ports.reader.pins.source = runtimeSource;
  f.ports.reader.pins.build = runtimeBuild;
  const ports: OwnedControlledHostProofPorts = {
    ...f.ports,
    controller: {
      ...f.ports.controller,
      async readOriginalIntent() {
        return structuredClone(intent);
      },
      async readOriginalEvidence() {
        return structuredClone({ ...evidence, provision });
      },
    },
  };
  const factory = createOwnedControlledHostProofFactory(
    ports,
    f.preparationContext,
    f.publication,
    f.completion,
  );
  return { ...f, factory, ownedPorts: ports, intent };
}

test("owned v3 host proof requires MAC-authenticated provision and preserves held compiler fences", async () => {
  const f = await ownedControlledFixture();
  assert.deepEqual(f.factory.hostAssurance, {
    kind: "controlled-native-runtime-v1",
    authority: "NONE",
    globalCleanHost: "NOT_PROVEN",
  });
  const prepared = await f.factory.prepare();
  assert.equal(
    prepared.verifyHostBindings(f.compilerPins).profileVersion,
    "isolated-stdout-v1",
  );
  f.loseWindow();
  assert.throws(prepared.recheck, /CONTROLLED_WINDOW_REVOKED/);
});

test("owned v3 host proof rejects an unsigned original provision", async () => {
  const f = await ownedControlledFixture();
  f.signed.splice(
    f.signed.findIndex((ref) => ref.path === "/original/provision"),
    1,
  );
  await assert.rejects(f.factory.prepare(), {
    code: "BOOTSTRAP_CLOSURE_UNPROVEN",
  });
});

for (const fault of ["source", "build"] as const)
  test(`owned v3 requires runtime ${fault} from original provision, not installed identity`, async () => {
    const f = await ownedControlledFixture(
      fault === "source"
        ? { runtimeSource: "9".repeat(40) }
        : { runtimeBuild: "9".repeat(64) },
    );
    await assert.rejects(f.factory.prepare(), {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
    });
    assert.equal(
      f.calls(),
      0,
      "do not consult activation for mismatched original admission pins",
    );
  });

test("manual host proof cannot accept the owned v3 controller", async () => {
  const f = await ownedControlledFixture();
  const manual = Reflect.apply(createControlledHostProofFactory, undefined, [
    f.ownedPorts,
    f.preparationContext,
    f.publication,
    f.completion,
  ]);
  await assert.rejects(manual.prepare(), {
    code: "BOOTSTRAP_CLOSURE_UNPROVEN",
  });
});

test("controlled origin and MAC-authenticated original references yield a held compiler port, not a serialized grant", async () => {
  const f = await controlledFixture();
  const prepared = await f.factory.prepare();
  assert.deepEqual(prepared.verifyHostBindings(f.compilerPins), {
    proofHash: prepared.verifyHostBindings(f.compilerPins).proofHash,
    profileVersion: "isolated-stdout-v1",
  });
  assert.match(
    prepared.verifyHostBindings(f.compilerPins).proofHash,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(f.calls(), 1);
  await f.factory.prepare();
  assert.equal(f.calls(), 2, "every new preparation verifies native evidence");
  f.loseWindow();
  assert.throws(prepared.recheck, /CONTROLLED_WINDOW_REVOKED/);
  await assert.rejects(f.factory.prepare(), { code: "FRESH_HOST_REVOKED" });
});

test("bootstrap MAC reference port preserves original native paths and private controller fences without copying authority", async () => {
  const f = await controlledFixture();
  const port = await prepareControlledBootstrapOriginals(
    f.ports.controller,
    f.ports.transcript,
  );
  const expected = f.context.originalRefs.map((ref) => ({
    path: ref.nativePath,
    sha256: ref.sha256,
  }));
  assert.deepEqual(port.readCurrentReferences(), expected);
  port.readCurrentReferences()[0]!.sha256 = "0".repeat(64);
  assert.deepEqual(
    port.readCurrentReferences(),
    expected,
    "mutating a returned data copy must not change original controller evidence",
  );
  f.loseWindow();
  assert.throws(port.assertCurrent, /CONTROLLED_WINDOW_REVOKED/);
  assert.throws(port.readCurrentReferences, /CONTROLLED_WINDOW_REVOKED/);
});

for (const owned of [false, true])
  test(`private ${owned ? "owned v3" : "manual v2"} provider uses the actual kernel, original input and a new native reader for each preparation`, async () => {
    const ownedFixture = owned ? await ownedControlledFixture() : undefined;
    const f = ownedFixture ?? (await controlledFixture());
    const sha = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    f.preparationContext.brokerBuild = f.compilerPins.buildHash = sha("broker");
    f.preparationContext.brokerConfig = f.compilerPins.configHash =
      sha("config");
    let readers = 0;
    const common = {
      transcript: f.ports.transcript,
      startupInputs: f.startupInputs,
      assertBootstrapHeld: f.ports.assertBootstrapHeld,
      readCurrentHost: () => {
        const {
          descriptor,
          brokerBuild,
          brokerConfig,
          purpose,
          engineVersion,
        } = f.preparationContext;
        return {
          descriptor,
          brokerBuild,
          brokerConfig,
          purpose,
          engineVersion,
        };
      },
      createReader() {
        readers++;
        return { ...f.ports.reader };
      },
    };
    const provider = ownedFixture
      ? createOwnedControlledStdoutProvider(
          { ...common, controller: ownedFixture.ownedPorts.controller },
          f.publication,
          f.completion,
        )
      : createControlledStdoutProvider(
          { ...common, controller: f.ports.controller },
          f.publication,
          f.completion,
        );
    const request = {
      kind: "rpc" as const,
      backend: "addin",
      clientId: "provider-client",
      requestId: "provider-request",
      timeoutMs: 45000,
      ownerToken: "a".repeat(64),
      payload: {
        jsonrpc: "2.0",
        id: "original-id",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: { code: "print('provider output')", persistent: false },
        },
      },
    };
    const ports = await provider(request, f.compilerPins);
    const compiled = await compilePythonStdout(request, ports);
    assert.ok(compiled);
    assert.equal(
      compiled.descriptor.sourceHash,
      pythonStdoutInputDigests(request).sourceDigest,
    );
    const rpc = compiled.rpc();
    const params = rpc["params"];
    assert.ok(params && typeof params === "object" && "arguments" in params);
    const args = params.arguments;
    assert.ok(args && typeof args === "object" && "code" in args);
    assert.notEqual(
      args.code,
      request.payload.params.arguments.code,
      "the real kernel must be generated, not the original script forwarded",
    );
    compiled.assertWire(
      request,
      { ...rpc, id: "fmcad:owned-turn" },
      "owned-turn",
    );
    await provider(request, f.compilerPins);
    assert.equal(readers, 2);
    assert.equal(f.calls(), 2);
    f.loseWindow();
    assert.throws(
      () => compiled.reverify(request),
      /CONTROLLED_WINDOW_REVOKED/,
    );
  });

test("missing or mismatched authenticated original references permanently deny the window", async () => {
  for (const alter of [
    (f: Awaited<ReturnType<typeof controlledFixture>>) => f.signed.pop(),
    (f: Awaited<ReturnType<typeof controlledFixture>>) => {
      f.signed[0]!.sha256 = "f".repeat(64);
    },
    (f: Awaited<ReturnType<typeof controlledFixture>>) => {
      f.signed[0]!.path = "/copied/not-original";
    },
  ]) {
    const f = await controlledFixture();
    alter(f);
    await assert.rejects(f.factory.prepare(), {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
    });
    await assert.rejects(f.factory.prepare(), { code: "FRESH_HOST_REVOKED" });
  }
});

test("native or compiler context changes during or after preparation revoke the held port", async () => {
  const f = await controlledFixture();
  f.duringVerify(
    () => (f.current.descriptor.physicalRuntime.birth = "changed"),
  );
  await assert.rejects(f.factory.prepare(), {
    code: "FRESH_HOST_CONTEXT_CHANGED",
  });
  const g = await controlledFixture();
  const prepared = await g.factory.prepare();
  g.compilerPins.generation = "changed";
  assert.throws(prepared.recheck, { code: "FRESH_HOST_CONTEXT_CHANGED" });
  await assert.rejects(g.factory.prepare(), { code: "FRESH_HOST_REVOKED" });
});

for (const field of [
  "originalRequestDigest",
  "originalLogicalRpcDigest",
  "sourceDigest",
] as const)
  test(`controlled preparation rechecks original ${field} across native awaits`, async () => {
    const f = await controlledFixture();
    f.duringVerify(() => (f.preparationContext[field] = "f".repeat(64)));
    await assert.rejects(f.factory.prepare(), {
      code: "FRESH_HOST_CONTEXT_CHANGED",
    });
  });

test("old readers without authenticated references and native verification errors cannot prepare a controlled port", async () => {
  const f = await controlledFixture();
  f.ports.reader.verifyConsumed = async () => ({
    authenticatedCurrentPins: structuredClone(f.ports.reader.pins),
    finalize() {
      assert.fail("Unauthenticated references cannot be finalized");
    },
    abort() {},
  });
  await assert.rejects(f.factory.prepare(), {
    code: "BOOTSTRAP_CLOSURE_UNPROVEN",
  });
  const g = await controlledFixture();
  const error = new Error("NATIVE_MAC_CHANGED");
  g.failNative(error);
  await assert.rejects(g.factory.prepare(), (actual) => actual === error);
  await assert.rejects(g.factory.prepare(), { code: "FRESH_HOST_REVOKED" });
});

test("replacing the controlled origin with a JSON transcript or changing source bindings is refused", async () => {
  const f = await controlledFixture();
  f.ports.transcript = structuredClone(f.ports.transcript);
  await assert.rejects(f.factory.prepare(), {
    code: "FRESH_HOST_CONTEXT_CHANGED",
  });
  const g = await controlledFixture();
  g.context.installedBuild = "0".repeat(64);
  await assert.rejects(g.factory.prepare(), {
    code: "BOOTSTRAP_CLOSURE_UNPROVEN",
  });
});

test("unsupported bootstrap evidence and a mismatched compiler call revoke instead of falling back", async (t) => {
  const f = await controlledFixture();
  const read = f.ports.controller.readOriginalIntent;
  t.mock.method(
    f.ports.controller,
    "readOriginalIntent",
    async (original: ControlledFusionBootstrapTranscript) => {
      const intent = await read(original);
      intent.profile.sha256 = "0".repeat(64);
      return intent;
    },
  );
  await assert.rejects(f.factory.prepare(), {
    code: "BOOTSTRAP_CLOSURE_UNPROVEN",
  });
  const g = await controlledFixture();
  const prepared = await g.factory.prepare();
  assert.throws(
    () =>
      prepared.verifyHostBindings({
        ...g.compilerPins,
        buildHash: "different-build",
      }),
    { code: "FRESH_HOST_CONTEXT_CHANGED" },
  );
  assert.throws(prepared.recheck, { code: "FRESH_HOST_REVOKED" });
});

test("bootstrap MAC producer includes both original OS autorun inputs and retains their private fence", async () => {
  const f = await controlledFixture();
  const port = await prepareControlledBootstrapOriginals(
    f.ports.controller,
    f.ports.transcript,
    f.startupInputs,
  );
  for (const file of f.autorunFiles)
    assert.ok(
      port
        .readCurrentReferences()
        .some(
          (ref) => ref.path === file.nativePath && ref.sha256 === file.sha256,
        ),
    );
  f.changeStartupInputs();
  assert.throws(port.assertCurrent, /STARTUP_INPUT_REPLACED/);
  f.changeStartupInputs(false);
  assert.throws(port.readCurrentReferences, /Original held/);
});

test("bootstrap MAC producer unifies identical original roles without losing either live fence", async () => {
  const f = await controlledFixture();
  f.context.originalRefs.push(
    { ...f.context.originalRefs[0]! },
    ...f.autorunFiles.map(({ nativePath, sha256, identity }) => ({
      nativePath,
      sha256,
      identity,
    })),
  );
  const port = await prepareControlledBootstrapOriginals(
    f.ports.controller,
    f.ports.transcript,
    f.startupInputs,
  );
  const refs = port.readCurrentReferences();
  assert.equal(refs.length, f.context.originalRefs.length - 1);
  assert.equal(
    new Set(refs.map((ref) => ref.path.toLowerCase())).size,
    refs.length,
  );
  f.loseWindow();
  assert.throws(port.readCurrentReferences, /CONTROLLED_WINDOW_REVOKED/);
  const g = await controlledFixture();
  g.context.originalRefs.push(
    ...g.autorunFiles.map(({ nativePath, sha256, identity }) => ({
      nativePath,
      sha256,
      identity,
    })),
  );
  const startupPort = await prepareControlledBootstrapOriginals(
    g.ports.controller,
    g.ports.transcript,
    g.startupInputs,
  );
  g.changeStartupInputs();
  assert.throws(startupPort.readCurrentReferences, /STARTUP_INPUT_REPLACED/);
});

for (const conflict of ["digest", "identity", "alias"] as const)
  test(`bootstrap MAC producer refuses duplicate original ${conflict} conflicts`, async () => {
    const f = await controlledFixture();
    const original = f.autorunFiles[0]!;
    f.context.originalRefs.push({
      nativePath:
        conflict === "alias"
          ? original.nativePath.toUpperCase()
          : original.nativePath,
      sha256: conflict === "digest" ? "0".repeat(64) : original.sha256,
      identity: conflict === "identity" ? "replacement" : original.identity,
    });
    await assert.rejects(
      prepareControlledBootstrapOriginals(
        f.ports.controller,
        f.ports.transcript,
        f.startupInputs,
      ),
      { code: "BOOTSTRAP_CLOSURE_UNPROVEN" },
    );
  });

for (const drift of ["identity", "sha256", "nativePath", "roles"] as const)
  test(`bootstrap MAC producer rejects original ${drift} drift after preparation`, async () => {
    const f = await controlledFixture();
    const port = await prepareControlledBootstrapOriginals(
      f.ports.controller,
      f.ports.transcript,
      f.startupInputs,
    );
    if (drift === "roles") f.context.originalRefs.pop();
    else f.context.originalRefs[0]![drift] = "replaced-after-preparation";
    assert.throws(port.readCurrentReferences, {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
    });
    assert.throws(port.assertCurrent, {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
    });
  });

test("missing and serialized OS-input witnesses never qualify the controlled host", async () => {
  const f = await controlledFixture();
  const missing = { ...f.ports };
  Object.defineProperty(missing, "startupInputs", { value: undefined });
  await assert.rejects(
    createControlledHostProofFactory(
      missing,
      f.preparationContext,
      f.publication,
      f.completion,
    ).prepare(),
    { code: "BOOTSTRAP_CLOSURE_UNPROVEN" },
  );
  await assert.rejects(
    createControlledHostProofFactory(
      {
        ...f.ports,
        startupInputs: structuredClone(f.startupInputs),
      },
      f.preparationContext,
      f.publication,
      f.completion,
    ).prepare(),
    /Original held/,
  );
  assert.equal(f.calls(), 0);
});
test("authentic OS input witnesses must refer to global and user files adjacent to the original profile", async () => {
  const f = await controlledFixture({ autorunRoot: "C:\\unrelated" });
  await assert.rejects(f.factory.prepare(), {
    code: "BOOTSTRAP_CLOSURE_UNPROVEN",
  });
  assert.equal(f.calls(), 0);
});

for (const fault of [
  "foreign-running",
  "foreign-startup",
  "self-manifest",
  "api-parent",
  "missing-self",
] as const)
  test(`authenticated original audit still refuses ${fault} before preparing a compiler port`, async () => {
    const f = await controlledFixture();
    f.changeAuditedPolicy((audit) => {
      if (fault === "foreign-running") audit.scripts.items[1]!.isRunning = true;
      if (fault === "foreign-startup")
        Object.assign(audit.scripts.items[1]!, {
          isAddIn: true,
          isRunOnStartup: true,
        });
      if (fault === "self-manifest") {
        const content = '{"id":"not-the-pinned-fork"}';
        audit.scripts.items[0]!.manifest.content = content;
        audit.scripts.items[0]!.manifest.sha256 = createHash("sha256")
          .update(content)
          .digest("hex");
      }
      if (fault === "api-parent")
        audit.preferences.defaultPathForScriptsAndAddIns = "C:\\Other\\API";
      if (fault === "missing-self")
        Object.assign(audit.scripts.items[0]!, {
          folder: "C:\\Other\\Fork",
          isRunning: false,
        });
    });
    await assert.rejects(f.factory.prepare(), {
      code: "CONTROLLED_STARTUP_UNPROVEN",
    });
    assert.equal(
      f.calls(),
      0,
      "invalid startup data is not an authenticated SDK grant",
    );
    await assert.rejects(f.factory.prepare(), { code: "FRESH_HOST_REVOKED" });
  });

test("original OS-input loss across native verification cannot be restored into a host grant", async () => {
  const f = await controlledFixture();
  f.duringVerify(() => f.changeStartupInputs());
  await assert.rejects(f.factory.prepare(), /STARTUP_INPUT_REPLACED/);
  f.changeStartupInputs(false);
  await assert.rejects(f.factory.prepare(), { code: "FRESH_HOST_REVOKED" });
});

test("authenticated native evidence remains NOT_AUTHORITY; every use rechecks", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  assert.equal(assessment.status, "NOT_AUTHORITY");
  assert.ok(Object.isFrozen(assessment));
  assert.deepEqual(assessment.missing, [
    "SUPPORTED_BOOTSTRAP_PURPOSE_PRODUCER",
    "AUTHENTICATED_BOOTSTRAP_CLOSURE",
  ]);
  for (let i = 0; i < 2; i++)
    await assert.rejects(f.factory.requireForDispatch(assessment), {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
      notStarted: true,
    });
  assert.equal(f.calls(), 3);
});

test("JSON copies and assessments from another factory cannot be used", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  for (const copy of [
    structuredClone(assessment),
    await fixture().factory.assess(),
  ])
    await assert.rejects(f.factory.requireForDispatch(copy), {
      code: "FRESH_HOST_ASSESSMENT_REJECTED",
    });
  assert.equal(f.calls(), 1);
});

test("native verification failure propagates without granting an assessment", async () => {
  const f = fixture();
  const wrongMac = new Error("RUNTIME_CONSUME_MAC_INVALID");
  f.failNative(wrongMac);
  await assert.rejects(f.factory.assess(), (e) => e === wrongMac);
});

test("original publication and receipt inputs are detached from caller mutations", async () => {
  const f = fixture();
  f.publication.activationBytes = "forged";
  f.completion.nativeReceipt.reference.path = "/forged";
  assert.equal((await f.factory.assess()).status, "NOT_AUTHORITY");
});

test("lost current native grant denies assessment and dispatch recheck", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  f.loseGrant();
  await assert.rejects(f.factory.requireForDispatch(assessment), {
    code: "FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN",
  });
});

test("explicit revocation invalidates prior assessments permanently", async () => {
  const f = fixture();
  const assessment = await f.factory.assess();
  f.factory.revoke();
  await assert.rejects(f.factory.assess(), { code: "FRESH_HOST_REVOKED" });
  await assert.rejects(f.factory.requireForDispatch(assessment), {
    code: "FRESH_HOST_REVOKED",
  });
});

const mutations: Array<[string, (c: FreshHostContext) => void]> = [
  ["Fusion birth", (c) => (c.descriptor.physicalRuntime.birth += "-changed")],
  ["grant generation", (c) => (c.descriptor.generation.epoch += "-changed")],
  ["broker principal", (c) => (c.descriptor.brokerOwner.nonce += "-changed")],
  ["broker build", (c) => (c.brokerBuild += "-changed")],
  ["config", (c) => (c.brokerConfig += "-changed")],
  ["request", (c) => (c.requestId += "-changed")],
  ["kernel", (c) => (c.kernelDigest += "-changed")],
  ["program", (c) => (c.programDigest += "-changed")],
  ["wire", (c) => (c.wireDigest += "-changed")],
];
for (const [label, mutate] of mutations)
  test(`${label} is rechecked, including across awaits`, async () => {
    for (const phase of ["before", "verify", "activation"]) {
      const f = fixture();
      const assessment = await f.factory.assess();
      if (phase === "before") mutate(f.current);
      if (phase === "verify") f.duringVerify(() => mutate(f.current));
      if (phase === "activation") f.duringActivation(() => mutate(f.current));
      await assert.rejects(f.factory.requireForDispatch(assessment), {
        code: "FRESH_HOST_CONTEXT_CHANGED",
      });
    }
  });

test("bootstrap lease loss across native awaits is fail-closed", async () => {
  for (const phase of ["before", "verify", "activation"]) {
    const f = fixture();
    if (phase === "before") f.loseLease();
    if (phase === "verify") f.duringVerify(f.loseLease);
    if (phase === "activation") f.duringActivation(f.loseLease);
    await assert.rejects(f.factory.assess(), /BOOTSTRAP_LEASE_REVOKED/);
  }
});

test("native current pins cannot be substituted even with a held lease", async () => {
  const f = fixture();
  f.ports.reader.pins.process.birth = "stale";
  await assert.rejects(f.factory.assess(), {
    code: "FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN",
  });
});
