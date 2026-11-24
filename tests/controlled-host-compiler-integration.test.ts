import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path, { resolve } from "node:path";
import {
  prepareControlledBootstrapOriginals,
  type ControlledHostPreparationContext,
} from "../src/fresh-host-proof";
import {
  createBrokerRpcPreparation,
  type BrokerRpcPreparationPorts,
} from "../src/broker-rpc-preparation";
import {
  compilePythonStdout,
  pythonStdoutInputDigests,
  type CompiledPythonStdout,
  type DiagnosticRequest,
} from "../src/python-diagnostic-broker";
import {
  createControlledStdoutProvider,
  type ControlledStdoutProviderPorts,
} from "../src/controlled-stdout-provider";
import type { ProtocolMetadataPins } from "../src/protocol-metadata-broker";
import type * as P from "../src/queue-broker-ports";
import type { BrokerModules } from "../src/queue-broker-modules";
import { prepareMetadataWire } from "../src/queue-broker-modules";
import { controlledFusionBootstrapFixture } from "./controlled-fusion-bootstrap-fixture";
import * as platform from "../packages/node-adapters/src/config-platform";
import { createQueueInstance } from "../packages/node-adapters/src/execution/queue-instance";
import { prepareBrokerScript } from "../packages/node-adapters/src/execution/broker-preparation";
import { fencePreparedWire } from "../packages/node-adapters/src/execution/broker-physical";
import { createPythonRpcAdmission } from "../packages/node-adapters/src/python/admission";
import { createPythonChecker } from "../packages/node-adapters/src/python/checker";
import type {
  NativeRuntimeActivationCompletion,
  NativeRuntimeActivationPublication,
  NativeRebaselineReference,
  NativeRuntimeRebaselinePins,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import type { NativeRuntimeRebaselineReaderPorts } from "../packages/node-adapters/src/execution/runtime-rebaseline-reader";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";
import { prepareIsolatedStdout } from "../packages/node-adapters/src/python/isolated-stdout";
import {
  pythonArtifactManifest,
  retainPythonOrigin,
} from "../packages/node-adapters/src/python/context-binding";

const source = 'print("marker")\n';
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const queueAnchor = resolve("src/queue-broker.js");
const runtime = platform.resolveRuntimePaths({ anchor: queueAnchor }).runtime;
const prepareReceiptScript: BrokerModules["./queue-instance"]["prepareReceiptScript"] =
  createQueueInstance(queueAnchor, platform).prepareReceiptScript;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function brokerRpc(value: unknown): P.Rpc {
  const rpc = record(value);
  assert.equal(typeof rpc["jsonrpc"], "string");
  assert.equal(typeof rpc["method"], "string");
  return rpc as unknown as P.Rpc;
}

function rpcCode(value: unknown): string {
  const params = record(record(value)["params"]);
  const args = record(params["arguments"]);
  assert.equal(typeof args["code"], "string");
  return args["code"] as string;
}

function requestWithSource(
  request: DiagnosticRequest,
  nextSource: string,
): DiagnosticRequest {
  const changed = structuredClone(request);
  const params = record(record(changed.payload)["params"]);
  record(params["arguments"])["code"] = nextSource;
  return changed;
}

function diagnosticRequest(
  requestId = "controlled-host-offline-request",
  logicalRpcId = "controlled-host-original-rpc",
): DiagnosticRequest {
  return {
    kind: "rpc",
    backend: "addin",
    clientId: "controlled-host-offline-owner",
    requestId,
    ownerToken: "a".repeat(64),
    buildHash: "b".repeat(64),
    timeoutMs: 45_000,
    payload: {
      jsonrpc: "2.0",
      id: logicalRpcId,
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: source, persistent: false },
      },
    },
  };
}

/**
 * Offline native-MAC reader boundary fixture. It returns the same authenticated
 * pins/references shape consumed by the proof factory; it does not implement
 * cryptographic verification. The native reader's actual SQLite/MAC behavior
 * remains covered by runtime-rebaseline-reader.test.ts.
 */
function offlineNativeMacReaderFixture(input: {
  readonly store: string;
  readonly pins: NativeRuntimeRebaselinePins;
  readonly descriptor: PhysicalGenerationDescriptor;
  readonly publication: NativeRuntimeActivationPublication;
  readonly completion: NativeRuntimeActivationCompletion;
  readonly references: readonly NativeRebaselineReference[];
}) {
  let active = true;
  let authenticatedReferences = input.references.map((ref) => ({ ...ref }));
  let verifyCalls = 0;
  let finalizeCalls = 0;
  let abortCalls = 0;
  const activation = {
    requestId: input.completion.binding.requestId,
    fenceNonce: "offline-native-fence",
    newHead: input.completion.binding.newHead,
    publicationDigest: input.completion.binding.publicationDigest,
    receiptDigest: hash("offline native receipt"),
  };
  const reader: NativeRuntimeRebaselineReaderPorts = {
    store: input.store,
    pins: structuredClone(input.pins),
    invalidate() {
      active = false;
    },
    async verifyConsumed(publication, completion) {
      verifyCalls++;
      assert.ok(
        active,
        "offline reader must remain active during verification",
      );
      assert.deepEqual(publication, input.publication);
      assert.deepEqual(completion, input.completion);
      return {
        authenticatedCurrentPins: structuredClone(reader.pins),
        authenticatedIntentReferences: Object.freeze(
          authenticatedReferences.map((ref) => Object.freeze({ ...ref })),
        ),
        finalize() {
          assert.ok(active, "offline reader remains active through finalize");
          finalizeCalls++;
        },
        abort() {
          abortCalls++;
        },
      };
    },
    async getVerifiedActivation(descriptor) {
      assert.deepEqual(descriptor, input.descriptor);
      return active ? structuredClone(activation) : undefined;
    },
  };
  return {
    reader,
    omitReference(nativePath: string) {
      authenticatedReferences = authenticatedReferences.filter(
        (ref) => ref.path !== nativePath,
      );
    },
    stats() {
      return { verifyCalls, finalizeCalls, abortCalls, active };
    },
  };
}

async function controlledIntegrationFixture(
  overrides: {
    readonly controller?: ControlledStdoutProviderPorts["controller"];
    readonly transcript?: ControlledStdoutProviderPorts["transcript"];
    readonly request?: DiagnosticRequest;
    readonly tag?: string;
  } = {},
) {
  const bootstrap = controlledFusionBootstrapFixture({
    captureStartupInputs: true,
  });
  const transcript = await bootstrap.controller.run();
  assert.equal(transcript.state, "COMPLETED", transcript.error ?? "");
  const originWitness =
    await bootstrap.controller.prepareOriginalWitness(transcript);
  const startupInputs = bootstrap.startupInputs;
  assert.ok(startupInputs);
  const bootstrapOriginals = await prepareControlledBootstrapOriginals(
    bootstrap.controller,
    transcript,
    startupInputs,
  );
  const request = overrides.request ?? diagnosticRequest();
  const tag = overrides.tag ?? "default";
  const admissionStore = `/offline/native-admission-${tag}.sqlite3`;
  const compilerPins: ProtocolMetadataPins = {
    buildHash: "b".repeat(64),
    configHash: "c".repeat(64),
    generation: "offline-controlled-host-generation",
  };
  const descriptor: PhysicalGenerationDescriptor = {
    kind: "fmcad-physical-grant",
    version: 1,
    handoffId: `offline-controlled-handoff-${tag}`,
    generation: {
      epoch: `offline-epoch-${tag}`,
      instance: `offline-instance-${tag}`,
    },
    brokerOwner: {
      pid: 10,
      birth: "offline-broker-birth",
      nonce: "offline-broker-nonce",
      clientId: request.clientId,
      queueDirectory: "/tmp/opencode/offline-controlled-queue",
    },
    endpointURL: "http://localhost:8765/mcp",
    physicalRuntime: {
      pid: bootstrap.fresh.pid,
      birth: bootstrap.fresh.birth,
      version: "offline-controlled-runtime",
      source: bootstrap.native.installedSource,
      build: bootstrap.native.installedBuild,
    },
  };
  let hostIdentity: Pick<
    ControlledHostPreparationContext,
    "descriptor" | "brokerBuild" | "brokerConfig" | "purpose" | "engineVersion"
  > = {
    descriptor,
    brokerBuild: compilerPins.buildHash,
    brokerConfig: compilerPins.configHash,
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
  };
  const publication: NativeRuntimeActivationPublication = {
    store: admissionStore,
    storeDevice: 1,
    storeInode: 2,
    expectedHead: "offline-expected-head",
    expectedFiles: {},
    activationFile: "/offline/native-activation.json",
    activationBytes: "offline-native-publication-bytes",
    record: {
      path: `/offline/native-publication-record-${tag}.json`,
      sha256: hash("offline native publication record"),
    },
  };
  const completion: NativeRuntimeActivationCompletion = {
    binding: {
      requestId: `offline-consumed-request-${tag}`,
      newHead: `offline-consumed-head-${tag}`,
      publicationDigest: hash("offline publication"),
      initiatorOperatorId: "offline-native-operator",
    },
    evidence: [],
    nativeReceipt: {
      kind: "native-runtime-rebaseline-consume-v1",
      reference: {
        path: `/offline/native-consume-receipt-${tag}.json`,
        sha256: hash("offline native consume receipt"),
      },
    },
  };
  const nativePins: NativeRuntimeRebaselinePins = {
    handoffId: descriptor.handoffId,
    admissionStore,
    generation: structuredClone(descriptor.generation),
    process: {
      pid: descriptor.physicalRuntime.pid,
      birth: descriptor.physicalRuntime.birth,
    },
    source: descriptor.physicalRuntime.source,
    build: descriptor.physicalRuntime.build,
    endpoint: descriptor.endpointURL,
  };
  const offlineReaderReferences: NativeRebaselineReference[] = [
    ...bootstrapOriginals.readCurrentReferences(),
  ];
  let readerPins = nativePins;
  const readerFixtures: ReturnType<typeof offlineNativeMacReaderFixture>[] = [];
  const providerPorts: ControlledStdoutProviderPorts = {
    controller: overrides.controller ?? bootstrap.controller,
    transcript: overrides.transcript ?? transcript,
    startupInputs,
    assertBootstrapHeld() {
      // This is the real bootstrap's synchronous witness fence, not a stub.
      bootstrap.controller.assertPreparedWitness(originWitness);
    },
    readCurrentHost: () => structuredClone(hostIdentity),
    createReader() {
      const readerFixture = offlineNativeMacReaderFixture({
        store: admissionStore,
        pins: readerPins,
        descriptor,
        publication,
        completion,
        references: offlineReaderReferences,
      });
      readerFixtures.push(readerFixture);
      return readerFixture.reader;
    },
  };
  const prepareControlledStdout = createControlledStdoutProvider(
    providerPorts,
    publication,
    completion,
  );
  return {
    bootstrap,
    transcript,
    originWitness,
    bootstrapOriginals,
    startupInputs,
    providerPorts,
    prepareControlledStdout,
    hostIdentity,
    compilerPins,
    request,
    nativePins,
    publication,
    completion,
    readerFixtures,
    offlineReaderReferences,
    setHostBuild(build: string) {
      hostIdentity = { ...hostIdentity, brokerBuild: build };
    },
    setNativePins(pins: NativeRuntimeRebaselinePins) {
      readerPins = pins;
    },
    omitReference(nativePath: string) {
      const index = offlineReaderReferences.findIndex(
        (reference) => reference.path === nativePath,
      );
      if (index !== -1) offlineReaderReferences.splice(index, 1);
    },
  };
}

function normalPythonAdmission() {
  return createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });
}

function brokerRpcPreparationPorts(
  job: { readonly id: string; readonly request: DiagnosticRequest },
  stdoutProgram: CompiledPythonStdout,
  pythonAdmission: ReturnType<typeof createPythonRpcAdmission>,
): BrokerRpcPreparationPorts {
  const contextEpoch = 7;
  const instance: P.Instance = {
    pid: 41,
    birth: `controlled-host-${job.id}`,
    version: "offline-runtime",
  };
  return {
    buildHash: job.request.buildHash ?? "offline-broker-build",
    nativeMcp: false,
    nativePaths: { mapPath: (file) => file },
    view: () => ({
      epoch: null,
      admissionMode: "normal-multidocument",
      contextEpoch,
      approvedRuntimeRoot: false,
      metadataAdmission: false,
    }),
    runtimeInstance: () => instance,
    jobDirectory: (jobId) =>
      path.join("/tmp/opencode/controlled-host-rpc-preparation", jobId),
    admitEpochRequest: () => null,
    verifyPreparedJob(actualJob, actualEpoch) {
      assert.equal(actualJob.id, job.id);
      assert.equal(actualEpoch, contextEpoch);
    },
    isolatedTool(name, args) {
      assert.equal(name, "execute_python");
      assert.equal(args?.persistent, false);
      assert.equal(args?.code, rpcCode(stdoutProgram.rpc()));
    },
    localPreparation: () => ({ job, stdoutProgram }),
    metadata: {
      job: () => undefined,
      program: () => assert.fail("unexpected document metadata program"),
      assertDocumentMetadataRead: () =>
        assert.fail("unexpected document metadata assertion"),
    },
    prepareBrokerScript,
    prepareReceiptScript,
    retainPythonOrigin: (artifact, origin) =>
      retainPythonOrigin(
        artifact,
        origin as unknown as Parameters<typeof retainPythonOrigin>[1],
      ),
    prepareMetadataWire,
    pythonAdmission,
    localCheckOptions: () => ({}),
  };
}

test("offline native boundary plus same-process controlled origin compiles exact stdout artifact through the normal checker", async () => {
  const fixture = await controlledIntegrationFixture();
  assert.strictEqual(
    fixture.providerPorts.controller,
    fixture.bootstrap.controller,
  );
  assert.strictEqual(fixture.providerPorts.transcript, fixture.transcript);
  const { readControlledStartupInputs } = createRequire(__filename)(
    "../src/dist/node-adapters/execution/controlled-startup-inputs",
  ) as typeof import("../packages/node-adapters/src/execution/controlled-startup-inputs");
  const startupFiles = readControlledStartupInputs(fixture.startupInputs).files;
  assert.deepEqual(
    fixture.offlineReaderReferences,
    [...fixture.originWitness.context.originalRefs, ...startupFiles].map(
      ({ nativePath, sha256 }) => ({
        path: nativePath,
        sha256,
      }),
    ),
  );
  fixture.bootstrapOriginals.assertCurrent();
  assert.ok(
    fixture.bootstrap.events.indexOf(
      "original-startup-inputs-held-before-launch",
    ) < fixture.bootstrap.events.indexOf("launch"),
  );
  const signedPaths = new Set(
    fixture.offlineReaderReferences.map((reference) => reference.path),
  );
  for (const nativePath of [
    fixture.bootstrap.native.paths.intent,
    fixture.bootstrap.native.paths.entry,
    fixture.bootstrap.native.paths.returned,
    fixture.bootstrap.native.paths.transcript,
  ])
    assert.ok(
      signedPaths.has(nativePath),
      `missing original ref ${nativePath}`,
    );

  const ports = await fixture.prepareControlledStdout(
    fixture.request,
    fixture.compilerPins,
  );
  let kernel: ReturnType<typeof prepareIsolatedStdout> | undefined;
  const compiled = await compilePythonStdout(fixture.request, {
    ...ports,
    async prepareKernel(userSource) {
      assert.equal(userSource, source);
      const prepared = await ports.prepareKernel(userSource);
      assert.equal(prepared.status, "prepared");
      if (prepared.status !== "prepared")
        throw new Error("The provider did not prepare the bounded kernel");
      kernel = prepared;
      return prepared;
    },
  });
  assert.ok(compiled, "supported request compiles through the public function");
  assert.ok(kernel);
  assert.equal(kernel.status, "prepared");
  if (kernel.status !== "prepared")
    throw new Error("The original stdout source was not prepared");

  const userUnits = kernel.artifact.units.filter(
    (unit) => unit.role === "user",
  );
  assert.equal(userUnits.length, 1);
  assert.equal(userUnits[0]?.source, source);
  assert.equal(userUnits[0]?.sha256, hash(source));
  assert.equal(kernel.artifact.script, kernel.script);
  assert.equal(kernel.artifact.sha256, compiled.descriptor.programHash);
  assert.equal(compiled.descriptor.sourceHash, hash(source));
  assert.equal(
    compiled.descriptor.hostBindingHash,
    ports.verifyHostBindings(fixture.compilerPins).proofHash,
  );
  assert.deepEqual(compiled.origin(), pythonArtifactManifest(kernel.artifact));

  const report = await createPythonChecker({
    typingRoot: resolve("runtime/python/typing"),
  }).check({ artifact: kernel.artifact, context: { kind: "raw" } });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.wireHash, kernel.programHash);

  const logical = compiled.rpc();
  assert.equal(rpcCode(logical), kernel.script);
  assert.equal(rpcCode(fixture.request.payload), source);
  const finalWire: Record<string, unknown> = {
    ...record(logical),
    id: "fmcad:controlled-final-wire",
  };
  compiled.assertProgram(fixture.request, kernel.script);
  compiled.assertWire(fixture.request, finalWire, "controlled-final-wire");
  const badWire = structuredClone(finalWire);
  record(record(badWire["params"])["arguments"])["code"] +=
    "\n# caller-modified after compilation";
  assert.throws(
    () =>
      compiled.assertWire(fixture.request, badWire, "controlled-final-wire"),
    { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
  );
  assert.deepEqual(fixture.readerFixtures[0]?.stats(), {
    verifyCalls: 1,
    finalizeCalls: 1,
    abortCalls: 0,
    active: true,
  });
});

test("two same-source controlled RPCs get independent real receipt wrappers and certificates before physical send", async () => {
  const requestA = diagnosticRequest(
    "controlled-host-request-a",
    "controlled-host-logical-rpc-a",
  );
  const requestB = diagnosticRequest(
    "controlled-host-request-b",
    "controlled-host-logical-rpc-b",
  );
  const first = await controlledIntegrationFixture({
    request: requestA,
    tag: "rpc-a",
  });
  const second = await controlledIntegrationFixture({
    request: requestB,
    tag: "rpc-b",
  });
  const digestA = pythonStdoutInputDigests(requestA);
  const digestB = pythonStdoutInputDigests(requestB);
  assert.equal(digestA.sourceDigest, digestB.sourceDigest);
  assert.notEqual(digestA.originalRequestDigest, digestB.originalRequestDigest);
  assert.notEqual(
    digestA.originalLogicalRpcDigest,
    digestB.originalLogicalRpcDigest,
  );
  // These are the native host-proof receipts, not final broker RPC receipts.
  assert.notEqual(
    first.completion.nativeReceipt.reference.path,
    second.completion.nativeReceipt.reference.path,
  );
  assert.strictEqual(
    first.providerPorts.controller,
    first.bootstrap.controller,
  );
  assert.strictEqual(first.providerPorts.transcript, first.transcript);
  assert.strictEqual(
    second.providerPorts.controller,
    second.bootstrap.controller,
  );
  assert.strictEqual(second.providerPorts.transcript, second.transcript);

  const portsA = await first.prepareControlledStdout(
    requestA,
    first.compilerPins,
  );
  const portsB = await second.prepareControlledStdout(
    requestB,
    second.compilerPins,
  );
  const repeatPortsA = await first.prepareControlledStdout(
    requestA,
    first.compilerPins,
  );
  assert.notEqual(
    portsA.verifyHostBindings(first.compilerPins).proofHash,
    portsB.verifyHostBindings(second.compilerPins).proofHash,
  );
  assert.equal(
    portsA.verifyHostBindings(first.compilerPins).proofHash,
    repeatPortsA.verifyHostBindings(first.compilerPins).proofHash,
  );
  assert.equal(first.readerFixtures.length, 2);
  assert.notStrictEqual(
    first.readerFixtures[0]?.reader,
    first.readerFixtures[1]?.reader,
  );
  const compiledA = await compilePythonStdout(requestA, portsA);
  const compiledB = await compilePythonStdout(requestB, portsB);
  assert.ok(compiledA);
  assert.ok(compiledB);
  assert.equal(
    compiledA.descriptor.sourceHash,
    compiledB.descriptor.sourceHash,
  );
  assert.notEqual(
    compiledA.descriptor.requestHash,
    compiledB.descriptor.requestHash,
  );
  assert.notEqual(compiledA.descriptor.rpcHash, compiledB.descriptor.rpcHash);
  assert.equal(second.readerFixtures.length, 1);

  const admission = normalPythonAdmission();
  const jobA = { id: "stdout-owned-job-a", request: { ...requestA } };
  const jobB = { id: "stdout-owned-job-b", request: { ...requestB } };
  const preparedA = await createBrokerRpcPreparation(
    brokerRpcPreparationPorts(jobA, compiledA, admission),
  ).prepareOwnedPost(brokerRpc(compiledA.rpc()), jobA, compiledA.origin());
  const preparedB = await createBrokerRpcPreparation(
    brokerRpcPreparationPorts(jobB, compiledB, admission),
  ).prepareOwnedPost(brokerRpc(compiledB.rpc()), jobB, compiledB.origin());
  assert.ok(preparedA.pythonCertificate);
  assert.ok(preparedB.pythonCertificate);
  assert.equal(preparedA.pythonCertificate.kind, "python");
  assert.equal(preparedB.pythonCertificate.kind, "python");
  assert.equal(preparedA.pythonCertificate.report?.status, "passed");
  assert.equal(preparedB.pythonCertificate.report?.status, "passed");
  assert.equal(
    preparedA.pythonCertificate.report?.provenance.checker,
    "basedpyright",
  );
  assert.equal(
    preparedB.pythonCertificate.report?.provenance.checker,
    "basedpyright",
  );

  const receiptPathA = preparedA.record.receipt;
  const receiptPathB = preparedB.record.receipt;
  assert.ok(receiptPathA);
  assert.ok(receiptPathB);
  assert.notEqual(receiptPathA, receiptPathB);
  assert.ok(rpcCode(preparedA.outgoing).includes(receiptPathA));
  assert.ok(rpcCode(preparedB.outgoing).includes(receiptPathB));
  assert.notEqual(preparedA.rpcId, preparedB.rpcId);
  assert.equal(preparedA.outgoing.id, `fmcad:${preparedA.rpcId}`);
  assert.equal(preparedB.outgoing.id, `fmcad:${preparedB.rpcId}`);
  assert.notEqual(rpcCode(preparedA.outgoing), rpcCode(preparedB.outgoing));
  assert.equal(
    preparedA.record.pythonCheck?.provenance.wireHash,
    preparedA.pythonArtifact?.sha256,
  );
  assert.equal(
    preparedB.record.pythonCheck?.provenance.wireHash,
    preparedB.pythonArtifact?.sha256,
  );
  assert.doesNotThrow(() =>
    preparedA.pythonCertificate.fence(preparedA.outgoing),
  );
  assert.doesNotThrow(() =>
    preparedB.pythonCertificate.fence(preparedB.outgoing),
  );
  fencePreparedWire(preparedA);
  fencePreparedWire(preparedB);

  const pathBWithTransportIdA = structuredClone(preparedA.outgoing);
  record(record(pathBWithTransportIdA["params"])["arguments"])["code"] =
    rpcCode(preparedB.outgoing);
  assert.equal(pathBWithTransportIdA["id"], preparedA.outgoing.id);
  assert.ok(rpcCode(pathBWithTransportIdA).includes(receiptPathB));

  const pathAWithTransportIdB = structuredClone(preparedB.outgoing);
  record(record(pathAWithTransportIdB["params"])["arguments"])["code"] =
    rpcCode(preparedA.outgoing);
  assert.equal(pathAWithTransportIdB["id"], preparedB.outgoing.id);
  assert.ok(rpcCode(pathAWithTransportIdB).includes(receiptPathA));

  const changedCodeA = structuredClone(preparedA.outgoing);
  record(record(changedCodeA["params"])["arguments"])["code"] +=
    "\n# modified after receipt preparation";
  const changedCodeB = structuredClone(preparedB.outgoing);
  record(record(changedCodeB["params"])["arguments"])["code"] +=
    "\n# modified after receipt preparation";

  const changedTransportIdA = structuredClone(preparedA.outgoing);
  changedTransportIdA.id = preparedB.outgoing.id;
  const changedTransportIdB = structuredClone(preparedB.outgoing);
  changedTransportIdB.id = preparedA.outgoing.id;

  const substitutions = [
    {
      name: "foreign receipt path/code",
      prepared: preparedA,
      wire: pathBWithTransportIdA,
    },
    {
      name: "foreign receipt path/code",
      prepared: preparedB,
      wire: pathAWithTransportIdB,
    },
    { name: "changed wrapped code", prepared: preparedA, wire: changedCodeA },
    { name: "changed wrapped code", prepared: preparedB, wire: changedCodeB },
    {
      name: "foreign transport RPC id",
      prepared: preparedA,
      wire: changedTransportIdA,
    },
    {
      name: "foreign transport RPC id",
      prepared: preparedB,
      wire: changedTransportIdB,
    },
  ];
  let physicalSendCalls = 0;
  // This is an in-process boundary counter only; no SDK or transport is created.
  const physicalSendSentinel = () => {
    physicalSendCalls++;
  };
  const fenceBeforePhysicalSend = (prepared: P.PreparedCall, wire: P.Rpc) => {
    assert.ok(prepared.pythonCertificate);
    fencePreparedWire({
      outgoing: wire,
      pythonCertificate: prepared.pythonCertificate,
      pythonArtifact: prepared.pythonArtifact,
    });
    physicalSendSentinel();
  };
  for (const substitution of substitutions) {
    assert.throws(
      () => substitution.prepared.pythonCertificate!.fence(substitution.wire),
      { code: "PYTHON_ADMISSION_CHANGED" },
      substitution.name,
    );
    assert.throws(
      () => fenceBeforePhysicalSend(substitution.prepared, substitution.wire),
      { code: "PYTHON_ADMISSION_CHANGED" },
      substitution.name,
    );
    assert.equal(physicalSendCalls, 0, substitution.name);
  }
});

test("JSON transcript copies and foreign real controllers cannot provide the controlled origin", async () => {
  const serialized = await controlledIntegrationFixture();
  const serializedProvider = createControlledStdoutProvider(
    {
      ...serialized.providerPorts,
      transcript: structuredClone(serialized.transcript),
    },
    serialized.publication,
    serialized.completion,
  );
  await assert.rejects(
    serializedProvider(serialized.request, serialized.compilerPins),
    /Original held controlled bootstrap witness required/,
  );
  assert.equal(serialized.readerFixtures[0]?.stats().verifyCalls, 0);

  const original = await controlledIntegrationFixture();
  const foreignBootstrap = controlledFusionBootstrapFixture();
  assert.equal((await foreignBootstrap.controller.run()).state, "COMPLETED");
  const foreignProvider = createControlledStdoutProvider(
    { ...original.providerPorts, controller: foreignBootstrap.controller },
    original.publication,
    original.completion,
  );
  await assert.rejects(
    foreignProvider(original.request, original.compilerPins),
    /Original held controlled bootstrap witness required/,
  );
  assert.equal(original.readerFixtures[0]?.stats().verifyCalls, 0);
});

test("controller window revocation during awaited compilation and final-wire assertion fails closed", async () => {
  const duringCompile = await controlledIntegrationFixture();
  const ports = await duringCompile.prepareControlledStdout(
    duringCompile.request,
    duringCompile.compilerPins,
  );
  let kernelCalls = 0;
  await assert.rejects(
    compilePythonStdout(duringCompile.request, {
      ...ports,
      async prepareKernel(userSource) {
        kernelCalls++;
        const prepared = await ports.prepareKernel(userSource);
        duringCompile.bootstrap.revoke();
        return prepared;
      },
    }),
    /lease revoked|Original controlled window revoked/,
  );
  assert.equal(kernelCalls, 1);

  const atWire = await controlledIntegrationFixture();
  const wirePorts = await atWire.prepareControlledStdout(
    atWire.request,
    atWire.compilerPins,
  );
  const compiled = await compilePythonStdout(atWire.request, wirePorts);
  assert.ok(compiled);
  const finalWire = {
    ...record(compiled.rpc()),
    id: "fmcad:revoked-final-wire",
  };
  atWire.bootstrap.revoke();
  assert.throws(
    () => compiled.assertWire(atWire.request, finalWire, "revoked-final-wire"),
    /lease revoked|Original controlled window revoked/,
  );
});

test("a rejecting asynchronous controller fence denies provider preparation without child unhandled rejection", () => {
  const fixturePath = resolve(
    "dist/tests/controlled-fusion-bootstrap-fixture.js",
  );
  const providerPath = resolve("dist/src/controlled-stdout-provider.js");
  const childScript = `
const { controlledFusionBootstrapFixture } = require(${JSON.stringify(fixturePath)});
const { createControlledStdoutProvider } = require(${JSON.stringify(providerPath)});
(async () => {
  const fixture = controlledFusionBootstrapFixture({ captureStartupInputs: true });
  const transcript = await fixture.controller.run();
  fixture.rejectNextLeaseFence();
  const request = {
    kind: "rpc",
    clientId: "async-fence-owner",
    requestId: "async-fence-request",
    ownerToken: "a".repeat(64),
    payload: {
      jsonrpc: "2.0",
      id: "async-fence-rpc",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: 'print("marker")\\n', persistent: false },
      },
    },
  };
  const pins = {
    buildHash: "b".repeat(64),
    configHash: "c".repeat(64),
    generation: "async-fence-generation",
  };
  const host = {
    descriptor: {
      kind: "fmcad-physical-grant",
      version: 1,
      handoffId: "async-fence-handoff",
      generation: { epoch: "async-fence-epoch", instance: "async-fence-instance" },
      brokerOwner: {
        pid: 10,
        birth: "broker-birth",
        nonce: "broker-nonce",
        clientId: request.clientId,
        queueDirectory: "/tmp/opencode/async-fence",
      },
      endpointURL: "http://localhost:8765/mcp",
      physicalRuntime: {
        pid: fixture.fresh.pid,
        birth: fixture.fresh.birth,
        version: "offline-runtime",
        source: fixture.native.installedSource,
        build: fixture.native.installedBuild,
      },
    },
    brokerBuild: pins.buildHash,
    brokerConfig: pins.configHash,
    purpose: "isolated-stdout-v1",
    engineVersion: 2,
  };
  let nativeVerifyCalls = 0;
  let readerInvalidations = 0;
  const provider = createControlledStdoutProvider({
    controller: fixture.controller,
    transcript,
    startupInputs: fixture.startupInputs,
    assertBootstrapHeld() {},
    readCurrentHost: () => host,
    createReader() {
      return {
        store: "/offline/async-fence.sqlite3",
        pins: {},
        invalidate() { readerInvalidations++; },
        async verifyConsumed() {
          nativeVerifyCalls++;
          throw new Error("native verification must not be reached");
        },
        async getVerifiedActivation() {
          nativeVerifyCalls++;
          return undefined;
        },
      };
    },
  }, {}, {});
  let denied = false;
  try {
    await provider(request, pins);
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("provider accepted the rejecting lease fence");
  if (fixture.rejectedLeaseFenceCount() !== 1)
    throw new Error("the real controller fence did not reject");
  if (nativeVerifyCalls !== 0)
    throw new Error("native/SDK verification ran after the fence denial");
  if (readerInvalidations !== 1)
    throw new Error("provider did not revoke its dedicated reader");
  if (fixture.events.filter((event) => event === "start-once").length !== 1)
    throw new Error("the denial retried controlled startup");
  process.stdout.write("DENIED_WITHOUT_UNHANDLED_REJECTION\\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  const child = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "-e", childScript],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /DENIED_WITHOUT_UNHANDLED_REJECTION/);
  assert.doesNotMatch(
    child.stderr,
    /UnhandledPromiseRejection|unhandledRejection/,
  );
});

test("source and broker-pin changes across the kernel await cannot pass program or host checks", async () => {
  const sourceChanged = await controlledIntegrationFixture();
  const ports = await sourceChanged.prepareControlledStdout(
    sourceChanged.request,
    sourceChanged.compilerPins,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let capturedKernel: ReturnType<typeof prepareIsolatedStdout> | undefined;
  const pending = compilePythonStdout(sourceChanged.request, {
    ...ports,
    async prepareKernel(userSource) {
      assert.equal(userSource, source);
      await gate;
      const prepared = await ports.prepareKernel(userSource);
      assert.equal(prepared.status, "prepared");
      if (prepared.status !== "prepared")
        throw new Error("The exact source was not prepared");
      capturedKernel = prepared;
      return prepared;
    },
  });
  sourceChanged.request.payload = requestWithSource(
    sourceChanged.request,
    'print("changed while awaiting kernel")\n',
  ).payload;
  release();
  const compiled = await pending;
  assert.ok(compiled);
  const exactKernel = capturedKernel;
  assert.ok(exactKernel);
  if (exactKernel?.status !== "prepared")
    throw new Error("The provider did not return its exact compiled kernel");
  assert.throws(
    () => compiled.assertProgram(sourceChanged.request, exactKernel.script),
    { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
  );
  const wire = { ...record(compiled.rpc()), id: "fmcad:changed-source-wire" };
  assert.throws(
    () =>
      compiled.assertWire(sourceChanged.request, wire, "changed-source-wire"),
    { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
  );

  const pinsChanged = await controlledIntegrationFixture();
  const hostPorts = await pinsChanged.prepareControlledStdout(
    pinsChanged.request,
    pinsChanged.compilerPins,
  );
  await assert.rejects(
    compilePythonStdout(pinsChanged.request, {
      ...hostPorts,
      async prepareKernel(userSource) {
        const prepared = await hostPorts.prepareKernel(userSource);
        pinsChanged.setHostBuild("changed-during-kernel-await");
        return prepared;
      },
    }),
    { code: "FRESH_HOST_CONTEXT_CHANGED" },
  );
});

test("offline native-reader boundary rejects mismatched actual pins and missing original receipt references", async () => {
  const changedPins = await controlledIntegrationFixture();
  changedPins.setNativePins({
    ...changedPins.nativePins,
    process: {
      ...changedPins.nativePins.process,
      birth: "different-native-birth",
    },
  });
  await assert.rejects(
    changedPins.prepareControlledStdout(
      changedPins.request,
      changedPins.compilerPins,
    ),
    {
      code: "BOOTSTRAP_CLOSURE_UNPROVEN",
    },
  );
  assert.equal(changedPins.readerFixtures[0]?.stats().abortCalls, 1);
  assert.equal(changedPins.readerFixtures[0]?.stats().active, false);

  const missingReference = await controlledIntegrationFixture();
  missingReference.omitReference(missingReference.bootstrap.native.paths.entry);
  await assert.rejects(
    missingReference.prepareControlledStdout(
      missingReference.request,
      missingReference.compilerPins,
    ),
    { code: "BOOTSTRAP_CLOSURE_UNPROVEN" },
  );
  assert.equal(missingReference.readerFixtures[0]?.stats().abortCalls, 1);
  assert.equal(missingReference.readerFixtures[0]?.stats().active, false);
});
