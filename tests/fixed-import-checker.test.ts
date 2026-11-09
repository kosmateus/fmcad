import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import type { JsonRecord } from "./live-import-receipts.js";

type FixedProgram =
  | "containment"
  | "sections"
  | "sketch-proof"
  | "measured-fasteners"
  | "drive-motion"
  | "drive-precision"
  | "gm12-spring"
  | "gm07-curves"
  | "data-import";
interface DocumentIdentity {
  name: string;
  creationId: string;
  fileId: null;
}
interface ProcessInstance {
  pid: number;
  birth: string;
  version: string;
}
interface PreparedArtifact extends JsonRecord {
  script: string;
}
interface QueueInstanceModule {
  processBirth(): string;
  buildHash(): string;
}
interface ConfigPlatformModule {
  resolveRuntimePaths(input: { anchor: string }): {
    runtime: string;
    typing?: string;
  };
}
interface RunModule {
  prepareRunScript(
    file: string,
    args: JsonRecord,
    approved: boolean,
    documentName: string,
    identity: { docId: string },
    helperVersion: string,
    helpers: string[],
    options: { projectDirectory: string },
  ): PreparedArtifact;
}
interface RecoveryAuditModule {
  prepareRecoveryAuditWire(input: JsonRecord): {
    outgoing: JsonRecord;
    artifact: PreparedArtifact;
  };
}
interface AdmissionCertificate extends JsonRecord {
  report: { status: string; provenance: { checker: string } };
  fence(outgoing: JsonRecord): void;
}
interface QueueAdmissionModule {
  createProductionQueueAdmission(runtime: string): {
    admission: {
      check(
        outgoing: JsonRecord,
        artifact: PreparedArtifact,
      ): Promise<AdmissionCertificate>;
    };
  };
}
interface TypingPointer extends JsonRecord {
  snapshot: string;
}

const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);
const programs: readonly FixedProgram[] = [
  "containment",
  "sections",
  "sketch-proof",
  "measured-fasteners",
  "drive-motion",
  "drive-precision",
  "gm12-spring",
  "gm07-curves",
  "data-import",
];

function parseTypingPointer(value: unknown): TypingPointer {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Typing pointer must be an object",
  );
  const row = value as JsonRecord;
  assert.equal(
    typeof row["snapshot"],
    "string",
    "Typing pointer must identify a generated snapshot",
  );
  assert.match(
    row["snapshot"] as string,
    /^[a-f0-9]{64}$/,
    "Generated typing pointer must name an exact snapshot",
  );
  return { snapshot: row["snapshot"] as string };
}

for (const program of programs) {
  test(
    `production checker qualifies fixed ${program} through the existing cad-v1 prepare/wire path`,
    { timeout: 180_000 },
    async (t) => {
      const installFakeWslPlatform = runtimeRequire(
        path.join(projectRoot, "tests/fixtures/fake-wsl-platform.cjs"),
      ) as () => () => void;
      t.after(installFakeWslPlatform());
      const pathsModule = runtimeRequire(
        path.join(projectRoot, "src/dist/config-platform/index.js"),
      ) as ConfigPlatformModule;
      const runtimeRoot = pathsModule.resolveRuntimePaths({
        anchor: __filename,
      }).runtime;
      const typingPointerPath = path.join(runtimeRoot, "typing/current.json");
      if (!fs.existsSync(typingPointerPath)) {
        t.skip(
          "Full production checker qualification requires the generated typing snapshot from npm run build; no checker analysis was run.",
        );
        return;
      }
      const pointer = parseTypingPointer(
        JSON.parse(fs.readFileSync(typingPointerPath, "utf8")) as unknown,
      );
      const typingManifestPath = path.join(
        runtimeRoot,
        "typing/snapshots",
        pointer.snapshot,
        "manifest.json",
      );
      const typingManifest = fs.readFileSync(typingManifestPath);
      assert.equal(
        createHash("sha256").update(typingManifest).digest("hex"),
        pointer.snapshot,
        "Generated typing manifest must match its content-addressed snapshot",
      );

      const output = fs.mkdtempSync("/tmp/opencode/fixed-native-program-");
      t.after(() => fs.rmSync(output, { recursive: true, force: true }));
      const queueInstance = runtimeRequire(
        path.join(projectRoot, "src/queue-instance.js"),
      ) as QueueInstanceModule;
      const document: DocumentIdentity = {
        name: "FMCAD_OFFLINE_CONTAINMENT",
        creationId: "owned-offline-id",
        fileId: null,
      };
      const instance: ProcessInstance = {
        pid: process.pid,
        birth: queueInstance.processBirth(),
        version: "offline-fixture",
      };
      const fixturePrefixes: Partial<Record<FixedProgram, string>> = {
        "gm07-curves": "NQGM07CURVE01",
        "data-import": "NQGM07IMPORT01",
      };
      const runModule = runtimeRequire(
        path.join(projectRoot, "src/run.js"),
      ) as RunModule;
      const artifact = runModule.prepareRunScript(
        path.join(projectRoot, "assets/native-qualification", `${program}.py`),
        {
          approved: true,
          creationId: document.creationId,
          expectedFusionVersion: instance.version,
          fixturePrefix: fixturePrefixes[program] || "NQCONTAINMENT01",
        },
        true,
        document.name,
        { docId: document.creationId },
        "cad-v1",
        [],
        { projectDirectory: output },
      );
      const recoveryModule = runtimeRequire(
        path.join(projectRoot, "src/queue-atomic-recovery-audit.js"),
      ) as RecoveryAuditModule;
      const prepared = recoveryModule.prepareRecoveryAuditWire({
        reader: { artifact },
        receipt: path.join(output, "never-sent.json"),
        instance,
        buildHash: queueInstance.buildHash(),
        jobId: "offline-fixed-native",
        auditBinding: {
          purpose: "fixed-native-fixture-v1",
          currentInstance: instance,
          expectedDocument: document,
        },
        payload: {
          jsonrpc: "2.0",
          id: "offline",
          method: "tools/call",
          params: {
            name: "execute_python",
            arguments: {
              code: `${artifact.script}\n\nrun("")\n`,
              persistent: false,
            },
          },
        },
      });
      const admissionModule = runtimeRequire(
        path.join(projectRoot, "src/queue-admission.js"),
      ) as QueueAdmissionModule;
      const admissionRuntime = pathsModule.resolveRuntimePaths({
        anchor: __filename,
      }).runtime;
      const certificate = await admissionModule
        .createProductionQueueAdmission(admissionRuntime)
        .admission.check(prepared.outgoing, prepared.artifact);
      if (certificate.report.status !== "passed")
        t.diagnostic(
          `Production checker report: ${JSON.stringify(certificate.report)}`,
        );
      assert.equal(certificate.report.status, "passed");
      assert.equal(certificate.report.provenance.checker, "basedpyright");
      certificate.fence(prepared.outgoing);
      const changed = structuredClone(prepared.outgoing);
      const params = changed["params"];
      assert.ok(
        params !== null && typeof params === "object" && !Array.isArray(params),
      );
      const args = (params as JsonRecord)["arguments"];
      assert.ok(
        args !== null && typeof args === "object" && !Array.isArray(args),
      );
      const script = (args as JsonRecord)["code"];
      assert.equal(typeof script, "string");
      (args as JsonRecord)["code"] = `${script}\n# unsigned source drift`;
      assert.throws(() => certificate.fence(changed));
      assert.equal(fs.existsSync(path.join(output, "never-sent.json")), false);
    },
  );
}
