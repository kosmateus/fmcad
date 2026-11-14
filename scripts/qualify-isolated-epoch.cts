#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { PreparedPythonArtifact, PythonCheckReport } from "@fmcad/core";
const load = createRequire(__filename);
interface Reader {
  artifact: PreparedPythonArtifact;
}
interface Rpc {
  params: { arguments: { code: string } };
  [key: string]: unknown;
}
interface Wire {
  outgoing: Rpc;
  artifact: PreparedPythonArtifact;
  record: { binding: Record<string, unknown> };
}
type Binding = Record<string, unknown>;
type ReaderFactory = (
  runtime: string,
  identity: unknown,
  binding: Binding,
  output?: { directory: string },
) => Reader;
interface FixtureContract {
  script: string;
  scriptSha256: string;
  fixtureId: string;
  helperVersion: string;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

// Installed-artifact offline qualification. No broker, SDK or lifecycle port.

async function main() {
  const options: Record<string, string> = {},
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      ![
        "--runtime",
        "--output",
        "--source-commit",
        "--closed-fixture",
      ].includes(key) ||
      options[key] ||
      !value
    )
      throw new Error("Exact --runtime, --output and --source-commit required");
    options[key] = value;
  }
  const runtime = path.resolve(options["--runtime"] || ""),
    output = path.resolve(options["--output"] || "");
  if (
    !options["--runtime"] ||
    !options["--output"] ||
    !/^[a-f0-9]{40}$/.test(options["--source-commit"] || "") ||
    output === runtime ||
    output.startsWith(runtime + path.sep)
  )
    throw new Error(
      "Use an explicit private output outside the immutable runtime",
    );
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const api = load(runtime + "/src/queue-instance") as {
    buildHash(runtime: string): string;
    processBirth(): string;
  };
  const wire = load(runtime + "/src/queue-atomic-recovery-audit") as {
    prepareRecoveryAudit: ReaderFactory;
    prepareRecoveryAuditWire(input: {
      reader: Reader;
      receipt: string;
      instance: unknown;
      buildHash: string;
      jobId: string;
      auditBinding: Binding;
      payload: unknown;
    }): Wire;
  };
  const scratch = load(runtime + "/src/queue-scratch-qualification") as {
    prepareScratchQualification: ReaderFactory;
  };
  const manifest = object(
    JSON.parse(
      fs.readFileSync(runtime + "/runtime-build.json", "utf8"),
    ) as unknown,
  );
  const fingerprint = text(manifest["fingerprint"]);
  assert.equal(api.buildHash(runtime), fingerprint);
  const admission = load(runtime + "/src/queue-admission") as {
    createProductionQueueAdmission(runtime: string): {
      admission: {
        check(
          payload: Rpc,
          artifact: PreparedPythonArtifact,
        ): Promise<{ report: PythonCheckReport; fence(payload: Rpc): void }>;
      };
    };
    recoveryAuditAdmissionPreflight(
      wire: Wire,
    ): Promise<{ status: string; production: boolean }>;
  };
  const production = admission.createProductionQueueAdmission(
    runtime + "/runtime/python",
  );
  const current = {
    pid: process.pid,
    birth: api.processBirth(),
    version: "2706-fixture",
  };
  const historical = {
    pid: 2147483646,
    birth: "terminated:fixture",
    version: "2706-fixture",
  };
  const identity = {
    commandId: "fmcad_atomic_" + "a".repeat(32),
    sessionNonce: "b".repeat(32),
    runId: "installed-offline-audit",
    requestHash: "c".repeat(64),
    backend: "addin",
    resolvedIdentity: {
      name: "Historical fixture",
      creationId: "historical-id",
      fileId: null,
    },
  };
  const reports: Array<{
      operation: string;
      artifactHash: string;
      report: PythonCheckReport;
      finalByteTamperRejected: boolean;
    }> = [],
    neverSent: string[] = [];
  async function check(operation: string, reader: Reader, binding: Binding) {
    const receipt = path.join(output, "never-sent-" + reports.length + ".json");
    neverSent.push(receipt);
    const prepared = wire.prepareRecoveryAuditWire({
      reader,
      receipt,
      instance: current,
      buildHash: fingerprint,
      jobId: "offline-qualified-fixture",
      auditBinding: binding,
      payload: {
        jsonrpc: "2.0",
        id: "offline",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: {
            code: reader.artifact.script + '\n\nrun("")\n',
            persistent: false,
          },
        },
      },
    });
    const certificate = await production.admission.check(
      prepared.outgoing,
      prepared.artifact,
    );
    assert.equal(certificate.report.status, "passed");
    assert.equal(certificate.report.provenance.checker, "basedpyright");
    certificate.fence(prepared.outgoing);
    const changed = structuredClone(prepared.outgoing);
    changed.params.arguments.code += "\n# unapproved bytes";
    assert.throws(() => certificate.fence(changed));
    reports.push({
      operation,
      artifactHash: prepared.artifact.artifactHash,
      report: certificate.report,
      finalByteTamperRejected: true,
    });
    console.log(
      JSON.stringify({
        operation,
        status: "passed",
        checker: "basedpyright",
        artifactHash: prepared.artifact.artifactHash,
      }),
    );
    return prepared;
  }
  const auditBinding = {
    purpose: "atomic-recovery-audit-v1",
    currentInstance: current,
    historicalInstance: historical,
    historicalProcessState: "terminated",
  };
  const preparedAudit = await check(
    "current-audit",
    wire.prepareRecoveryAudit(runtime, identity, auditBinding),
    auditBinding,
  );
  const descriptor =
    await admission.recoveryAuditAdmissionPreflight(preparedAudit);
  assert.equal(descriptor.status, "passed");
  assert.equal(descriptor.production, true);
  const stripped = {
    ...preparedAudit,
    record: {
      ...preparedAudit.record,
      binding: { ...preparedAudit.record.binding },
    },
  };
  delete stripped.record.binding["auditExpectedInstance"];
  await assert.rejects(admission.recoveryAuditAdmissionPreflight(stripped));
  const successorBinding = {
    purpose: "atomic-recovery-audit-v1",
    expectedProcess: { pid: current.pid, birth: current.birth },
    successorAuthorityHash: "a".repeat(64),
  };
  const successorRead = await check(
    "dead-epoch-successor-current-audit",
    wire.prepareRecoveryAudit(runtime, identity, successorBinding),
    successorBinding,
  );
  assert.deepEqual(
    successorRead.record.binding["auditExpectedProcess"],
    successorBinding.expectedProcess,
  );
  assert.equal(
    successorRead.record.binding["auditExpectedInstance"],
    undefined,
  );
  const captureDirectory = path.join(output, "explicit-audit-facts-capture");
  fs.mkdirSync(captureDirectory, { mode: 0o700 });
  const captureBinding = {
    purpose: "atomic-recovery-audit-facts-capture-v1",
    currentInstance: current,
    historicalInstance: historical,
    originalRpcId: "original-audit-fixture",
    originalEvidenceHash: "a".repeat(64),
    captureProofPath: path.join(captureDirectory, "sdk-facts.json"),
  };
  await check(
    "explicit-audit-facts-capture",
    (
      load(runtime + "/src/queue-audit-facts-capture") as {
        prepareAuditFactsCapture: ReaderFactory;
      }
    ).prepareAuditFactsCapture(runtime, identity, captureBinding, {
      directory: captureDirectory,
    }),
    captureBinding,
  );
  const epochId = randomUUID(),
    document = {
      name: "FMCAD_ISOLATED_" + epochId,
      creationId: "new-fixture-id",
      fileId: null,
    };
  for (const purpose of [
    "isolated-scratch-epoch-v1",
    "isolated-scratch-close-v1",
  ]) {
    const directory = path.join(output, purpose);
    fs.mkdirSync(directory, { mode: 0o700 });
    const binding = {
      purpose,
      epochId,
      document,
      currentInstance: current,
      historicalInstance: historical,
      forbiddenIds: ["historical-id"],
      sdkProofPath: path.join(
        directory,
        purpose.includes("close") ? "sdk-closed.json" : "sdk-qualified.json",
      ),
    };
    await check(
      purpose,
      scratch.prepareScratchQualification(runtime, {}, binding, { directory }),
      binding,
    );
  }
  for (const purpose of [
    "isolated-scratch-epoch-v1",
    "isolated-scratch-close-v1",
  ]) {
    const directory = path.join(output, purpose + "-restore");
    fs.mkdirSync(directory, { mode: 0o700 });
    const closing = purpose.includes("close");
    const binding = {
      purpose,
      epochId,
      document,
      currentInstance: current,
      historicalInstance: historical,
      forbiddenIds: ["historical-id"],
      sdkProofPath: path.join(
        directory,
        closing ? "sdk-closed.json" : "sdk-qualified.json",
      ),
      ...(closing
        ? { restoreActiveCreationId: "captured-previous-active-id" }
        : { captureActiveDocument: true }),
    };
    await check(
      purpose + "-restore",
      scratch.prepareScratchQualification(runtime, {}, binding, { directory }),
      binding,
    );
  }
  const cases: Array<[string, unknown]> = [
    ["sketch.create", { name: "EpochSection", plane: "XY" }],
    [
      "sketch.geometry",
      {
        sketch: "EpochSection",
        geometry: [
          {
            type: "rectangle",
            start: ["0 mm", "0 mm", "0 mm"],
            end: ["10 mm", "6 mm", "0 mm"],
          },
        ],
      },
    ],
    [
      "model.extrude",
      {
        name: "EpochSolid",
        profile: { kind: "profile", sketch: "EpochSection", index: 0 },
        distance: "4 mm",
        operation: "newBody",
      },
    ],
    ["entity.list", { kind: "body" }],
    [
      "shape.box",
      { name: "RegionalBox", width: "10 mm", depth: "10 mm", height: "10 mm" },
    ],
    [
      "shape.ring",
      {
        name: "RegionalRing",
        outerRadius: "5 mm",
        innerRadius: "2 mm",
        height: "5 mm",
      },
    ],
    [
      "shape.cylinder",
      { name: "RegionalCylinder", radius: "5 mm", height: "5 mm" },
    ],
    [
      "geometry.compare-region",
      {
        before: "Before",
        after: "After",
        frame: {
          space: "component local",
          component: { kind: "component", name: "root" },
        },
        allowed: { include: ["After"] },
      },
    ],
    ["snapshot", {}],
  ];
  for (const [operation, data] of cases) {
    const artifact = (
      load(runtime + "/src/cad") as {
        prepareCadScript(
          operation: string,
          data: unknown,
          options: Record<string, unknown>,
        ): PreparedPythonArtifact;
      }
    ).prepareCadScript(operation, data, {
      doc: document.name,
      docId: document.creationId,
    });
    await check(
      operation,
      { artifact },
      {
        purpose: "isolated-epoch-modeling-v1",
        epochId,
        document,
        currentInstance: current,
        expectedDocument: document,
      },
    );
  }
  const fixed = (
    load(runtime + "/src/queue-native-fixture-grant") as {
      fixtureContract(id: string): FixtureContract;
    }
  ).fixtureContract("containment-program-v1");
  const fixedArtifact = (
    load(runtime + "/src/run") as {
      prepareRunScript(
        script: string,
        input: unknown,
        confirmed: boolean,
        doc: string,
        selectors: { docId: string },
        helper: string,
        extra: string[],
        options: { projectDirectory: string },
      ): PreparedPythonArtifact;
    }
  ).prepareRunScript(
    path.join(runtime, fixed.script),
    {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: current.version,
      fixturePrefix: "NQCONTAINMENT01",
    },
    true,
    document.name,
    { docId: document.creationId },
    fixed.helperVersion,
    [],
    { projectDirectory: output },
  );
  await check(
    "fixed-containment-cad-v1",
    { artifact: fixedArtifact },
    {
      purpose: "fixed-native-fixture-v1",
      currentInstance: current,
      expectedDocument: document,
      fixtureId: fixed.fixtureId,
      scriptSha256: fixed.scriptSha256,
    },
  );
  const sections = (
    load(runtime + "/src/queue-native-fixture-grant") as {
      fixtureContract(id: string): FixtureContract;
    }
  ).fixtureContract("sections-program-v1");
  const sectionsArtifact = (
    load(runtime + "/src/run") as {
      prepareRunScript(
        script: string,
        input: unknown,
        confirmed: boolean,
        doc: string,
        selectors: { docId: string },
        helper: string,
        extra: string[],
        options: { projectDirectory: string },
      ): PreparedPythonArtifact;
    }
  ).prepareRunScript(
    path.join(runtime, sections.script),
    {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: current.version,
      fixturePrefix: "NQSECTIONS01",
    },
    true,
    document.name,
    { docId: document.creationId },
    sections.helperVersion,
    [],
    { projectDirectory: output },
  );
  await check(
    "fixed-sections-cad-v1",
    { artifact: sectionsArtifact },
    {
      purpose: "fixed-native-fixture-v1",
      currentInstance: current,
      expectedDocument: document,
      fixtureId: sections.fixtureId,
      scriptSha256: sections.scriptSha256,
    },
  );
  const sketch = (
    load(runtime + "/src/queue-native-fixture-grant") as {
      fixtureContract(id: string): FixtureContract;
    }
  ).fixtureContract("sketch-proof-program-v1");
  const sketchArtifact = (
    load(runtime + "/src/run") as {
      prepareRunScript(
        script: string,
        input: unknown,
        confirmed: boolean,
        doc: string,
        selectors: { docId: string },
        helper: string,
        extra: string[],
        options: { projectDirectory: string },
      ): PreparedPythonArtifact;
    }
  ).prepareRunScript(
    path.join(runtime, sketch.script),
    {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: current.version,
      fixturePrefix: "NQSKETCH01",
    },
    true,
    document.name,
    { docId: document.creationId },
    sketch.helperVersion,
    [],
    { projectDirectory: output },
  );
  await check(
    "fixed-sketch-proof-cad-v1",
    { artifact: sketchArtifact },
    {
      purpose: "fixed-native-fixture-v1",
      currentInstance: current,
      expectedDocument: document,
      fixtureId: sketch.fixtureId,
      scriptSha256: sketch.scriptSha256,
    },
  );
  const fasteners = (
    load(runtime + "/src/queue-native-fixture-grant") as {
      fixtureContract(id: string): FixtureContract;
    }
  ).fixtureContract("measured-fasteners-program-v1");
  const fastenersArtifact = (
    load(runtime + "/src/run") as {
      prepareRunScript(
        script: string,
        input: unknown,
        confirmed: boolean,
        doc: string,
        selectors: { docId: string },
        helper: string,
        extra: string[],
        options: { projectDirectory: string },
      ): PreparedPythonArtifact;
    }
  ).prepareRunScript(
    path.join(runtime, fasteners.script),
    {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: current.version,
      fixturePrefix: "NQFASTENERS01",
    },
    true,
    document.name,
    { docId: document.creationId },
    fasteners.helperVersion,
    [],
    { projectDirectory: output },
  );
  await check(
    "fixed-measured-fasteners-cad-v1",
    { artifact: fastenersArtifact },
    {
      purpose: "fixed-native-fixture-v1",
      currentInstance: current,
      expectedDocument: document,
      fixtureId: fasteners.fixtureId,
      scriptSha256: fasteners.scriptSha256,
    },
  );
  const drive = (
    load(runtime + "/src/queue-native-fixture-grant") as {
      fixtureContract(id: string): FixtureContract;
    }
  ).fixtureContract("drive-motion-program-v1");
  const driveArtifact = (
    load(runtime + "/src/run") as {
      prepareRunScript(
        script: string,
        input: unknown,
        confirmed: boolean,
        doc: string,
        selectors: { docId: string },
        helper: string,
        extra: string[],
        options: { projectDirectory: string },
      ): PreparedPythonArtifact;
    }
  ).prepareRunScript(
    path.join(runtime, drive.script),
    {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: current.version,
      fixturePrefix: "NQDRIVE01",
    },
    true,
    document.name,
    { docId: document.creationId },
    drive.helperVersion,
    [],
    { projectDirectory: output },
  );
  await check(
    "fixed-drive-motion-cad-v1",
    { artifact: driveArtifact },
    {
      purpose: "fixed-native-fixture-v1",
      currentInstance: current,
      expectedDocument: document,
      fixtureId: drive.fixtureId,
      scriptSha256: drive.scriptSha256,
    },
  );
  const precision = (
    load(runtime + "/src/queue-native-fixture-grant") as {
      fixtureContract(id: string): FixtureContract;
    }
  ).fixtureContract("drive-precision-program-v1");
  const precisionArtifact = (
    load(runtime + "/src/run") as {
      prepareRunScript(
        script: string,
        input: unknown,
        confirmed: boolean,
        doc: string,
        selectors: { docId: string },
        helper: string,
        extra: string[],
        options: { projectDirectory: string },
      ): PreparedPythonArtifact;
    }
  ).prepareRunScript(
    path.join(runtime, precision.script),
    {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: current.version,
      fixturePrefix: "NQPRECISION01",
    },
    true,
    document.name,
    { docId: document.creationId },
    precision.helperVersion,
    [],
    { projectDirectory: output },
  );
  await check(
    "fixed-drive-precision-cad-v1",
    { artifact: precisionArtifact },
    {
      purpose: "fixed-native-fixture-v1",
      currentInstance: current,
      expectedDocument: document,
      fixtureId: precision.fixtureId,
      scriptSha256: precision.scriptSha256,
    },
  );
  const savedDocument = {
    name: "OFFLINE_NEW_SAVED_FIXTURE",
    creationId: "new-saved-fixture-id",
    fileId: "new-file-id",
    projectId: "native-project-id",
    folderId: "approved-new-folder-id",
    version: 1,
  };
  const savedArtifact = (
    load(runtime + "/src/cad") as {
      prepareCadScript(
        operation: string,
        data: unknown,
        options: Record<string, unknown>,
      ): PreparedPythonArtifact;
    }
  ).prepareCadScript(
    "document.status",
    {},
    {
      doc: savedDocument.name,
      docId: savedDocument.creationId,
      docFileId: savedDocument.fileId,
      projectId: savedDocument.projectId,
    },
  );
  await check(
    "saved-fixture-document-guard",
    { artifact: savedArtifact },
    {
      purpose: "saved-fixture-modeling-v1",
      currentInstance: current,
      expectedSavedDocument: savedDocument,
    },
  );
  const firstSaveArtifact = (
    load(runtime + "/src/cad") as {
      prepareCadScript(
        operation: string,
        data: unknown,
        options: Record<string, unknown>,
      ): PreparedPythonArtifact;
    }
  ).prepareCadScript(
    "document.save_as",
    {
      name: document.name,
      project: "APPROVED_TEST_PROJECT",
      folder: "APPROVED_NEW_FOLDER",
      expectedProjectId: "native-project",
      expectedFolderId: "approved-new-folder-id",
      confirm: true,
    },
    { doc: document.name, docId: document.creationId },
  );
  await check(
    "first-save-exact-folder-pin",
    { artifact: firstSaveArtifact },
    {
      purpose: "saved-fixture-first-save-v1",
      firstSave: true,
      currentInstance: current,
      expectedDocument: document,
    },
  );
  for (const purpose of [
    "saved-fixture-destination-v1",
    "saved-first-save-publication-v1",
    "saved-fixture-retain-v1",
  ]) {
    const directory = path.join(output, purpose);
    fs.mkdirSync(directory, { mode: 0o700 });
    const binding = {
      purpose,
      epochId,
      document,
      currentInstance: current,
      historicalInstance: historical,
      destination: {
        projectName: "APPROVED_TEST_PROJECT",
        projectId: "native-project",
        folderName: "APPROVED_NEW_FOLDER",
        folderId: "approved-folder-id",
      },
      expectedFileId: "new-file-id",
      savedDocument: {
        ...savedDocument,
        name: document.name,
        creationId: document.creationId,
        projectId: "native-project",
        folderId: "approved-folder-id",
        fileId: "new-file-id",
      },
      restoreActiveCreationId: "captured-previous-active-id",
      sdkProofPath: path.join(
        directory,
        purpose.includes("destination")
          ? "sdk-destination.json"
          : purpose.includes("retain")
            ? "sdk-retained.json"
            : "sdk-publication.json",
      ),
    };
    await check(
      purpose,
      (
        load(runtime + "/src/queue-saved-fixture-reader") as {
          prepareSavedFixtureReader: ReaderFactory;
        }
      ).prepareSavedFixtureReader(runtime, {}, binding, { directory }),
      binding,
    );
  }
  const publicClient = load(runtime + "/src/client") as {
    McpClient: new (options: { routing: string }) => {
      callTool(): Promise<unknown>;
    };
  };
  await assert.rejects(
    new publicClient.McpClient({ routing: "direct" }).callTool(),
    { code: "QUEUE_REQUIRED" },
  );
  for (const receipt of neverSent) assert.equal(fs.existsSync(receipt), false);
  let closedQualification: Record<string, unknown> | undefined;
  if (options["--closed-fixture"]) {
    const fixture = options["--closed-fixture"];
    if (!path.isAbsolute(fixture) || fs.realpathSync(fixture) !== fixture)
      throw new Error("Canonical synthetic closed-successor fixture required");
    const fixtureRoot = path.join(output, "closed-successor-fixture");
    fs.mkdirSync(fixtureRoot, { mode: 0o700 });
    const child = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "qualify-closed-successor-worker.cjs"),
        fixture,
        runtime,
        fixtureRoot,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    closedQualification = object(JSON.parse(child.stdout.trim()) as unknown);
    assert.equal(closedQualification["sdkRequestsSent"], 0);
    fs.writeFileSync(
      path.join(output, "closed-successor-metadata-qualification.json"),
      JSON.stringify(closedQualification, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  const result = {
    sourceCommit: options["--source-commit"],
    buildHash: fingerprint,
    verifiedAt: new Date().toISOString(),
    runtime,
    passed: true,
    productionAdmission: true,
    auditUpgradeQualified: true,
    processLossAuditQualified: true,
    isolatedEpochQualified: true,
    reports,
    migrationAdmission: descriptor,
    strippedEndpointGuardRejected: true,
    auditFactsCaptureQualified: true,
    deadEpochSuccessorReadQualified: true,
    deadEpochSuccessorRestoreQualified: true,
    regionalFixtureTypedOperationsQualified: true,
    fixedContainmentProgramQualified: true,
    fixedSectionsProgramQualified: true,
    fixedSketchProofProgramQualified: true,
    fixedMeasuredFastenersProgramQualified: true,
    fixedDriveMotionProgramQualified: true,
    fixedDrivePrecisionProgramQualified: true,
    savedFixtureDocumentGuardQualified: true,
    firstSaveTargetPinQualified: true,
    savedDestinationReaderQualified: true,
    savedPublicationReaderQualified: true,
    savedRetentionReaderQualified: true,
    publicDirectAccessRefused: true,
    actualCurrentAuditFactsVerified: false,
    liveSdkRequestsSent: 0,
    historicalOutcome: "unknown",
    historicalModelValidation: "not_performed",
    historicalRollbackVerification: "not_performed",
    modelingAdmission: "blocked-until-actual-audit-and-qualified-scratch",
    ...(closedQualification
      ? {
          closedEpochSuccessorQualified: true,
          closedSuccessorMetadataQualification: closedQualification,
        }
      : {}),
  };
  fs.writeFileSync(
    path.join(output, "installed-qualification.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
