import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import path from "node:path";
import type {
  ControlledFile,
  ControlledNativeAdapter,
  ControlledProcess,
  OwnedAutoloadLaunch,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";
import type {
  BootstrapOwnedEntryIntentV3,
  BootstrapOwnedEntryOriginals,
} from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import type { ControlledStartupInputs } from "../packages/node-adapters/src/execution/controlled-startup-inputs";
import type {
  ControlledFusionBootstrapTranscript,
  ControlledFusionLease,
  ControlledQualifiedPackagePins,
  ControlledRebindWitness,
} from "./controlled-fusion-bootstrap";

const load = createRequire(__filename);
const evidenceApi = load(
  "./dist/node-adapters/execution/bootstrap-entry-evidence",
) as typeof import("../packages/node-adapters/src/execution/bootstrap-entry-evidence");
const startupApi = load(
  "./dist/node-adapters/execution/controlled-startup-inputs",
) as typeof import("../packages/node-adapters/src/execution/controlled-startup-inputs");
const { assertOwnedBootstrapStartupData } = load(
  "./dist/node-adapters/execution/controlled-startup-policy",
) as typeof import("../packages/node-adapters/src/execution/controlled-startup-policy");
const { decodeAdmissionJson } = load(
  "./dist/node-adapters/execution/admission-json",
) as typeof import("../packages/node-adapters/src/execution/admission-json");
const { ControlledFusionNativeError } = load(
  "./dist/node-adapters/execution/controlled-fusion-launch",
) as typeof import("../packages/node-adapters/src/execution/controlled-fusion-launch");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const ref = (file: ControlledFile) => ({
  nativePath: file.nativePath,
  sha256: file.sha256,
  identity: file.identity,
});
const copy = (file: ControlledFile) => {
  if (hash(file.bytes) !== file.sha256)
    throw new Error("Owned original bytes differ");
  return Object.freeze({ ...file, bytes: Buffer.from(file.bytes) });
};
function sync(check: () => void) {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Original synchronous owned fence required");
  }
}
function decode(file: ControlledFile): unknown {
  return decodeAdmissionJson(
    new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).sort().join(",") === keys.split(",").sort().join(",")
  );
}

export interface OwnedBootstrapLifecycle {
  readonly handoffId: string;
  readonly generation: { readonly instance: string; readonly epoch: string };
  readonly database: { readonly nativePath: string; readonly identity: string };
  readonly handoffRequest: {
    readonly nativePath: string;
    readonly sha256: string;
  };
  readonly handoffReceipt: {
    readonly nativePath: string;
    readonly sha256: string;
  };
}
export interface PreparedOwnedLaunch {
  readonly startupInputs: ControlledStartupInputs;
  readonly discoveryOriginals: readonly ControlledFile[];
  /** Original discovery-completeness and OS-input witness, not a JSON claim. */
  fence(): void;
  assertCurrent(): Promise<void>;
  launchAfterDeath(
    old: ControlledProcess,
    nonce: string,
  ): Promise<OwnedAutoloadLaunch>;
}
export interface OwnedFusionBootstrapPorts {
  readonly native: ControlledNativeAdapter;
  readonly lifecycle: OwnedBootstrapLifecycle;
  acquireExclusiveLifecycleLease(): Promise<ControlledFusionLease>;
  qualifyNativeInstallationAfterDeath(input: {
    old: ControlledProcess;
    qualifiedPackagePins: ControlledQualifiedPackagePins;
  }): Promise<ControlledFile>;
  prepareBeforeLaunch(input: {
    old: ControlledProcess;
    lease: ControlledFusionLease;
    qualifiedPackagePins: ControlledQualifiedPackagePins;
  }): Promise<PreparedOwnedLaunch>;
  /** Observe the already bound/registered native generation. Never rebind again. */
  observeNativeRebound(input: {
    old: ControlledProcess;
    launch: OwnedAutoloadLaunch;
    qualifiedPackagePins: ControlledQualifiedPackagePins;
  }): Promise<ControlledRebindWitness>;
}

function verifyLaunch(
  launch: OwnedAutoloadLaunch,
  old: ControlledProcess,
  nonce: string,
  native: ControlledNativeAdapter,
  lifecycle: OwnedBootstrapLifecycle,
): BootstrapOwnedEntryIntentV3 {
  const intent = decode(launch.intent);
  if (
    !object(intent) ||
    intent["version"] !== 3 ||
    intent["mode"] !== "owned-autoload-v1" ||
    launch.startupProven !== false ||
    !same(intent["process"], launch.process) ||
    launch.process.pid === old.pid ||
    launch.process.birth === old.birth ||
    !same(intent["generation"], lifecycle.generation) ||
    !same(intent["provision"], {
      path: launch.provision.nativePath,
      sha256: launch.provision.sha256,
    }) ||
    intent["nonce"] !== nonce
  )
    throw new Error("Owned launch intent binding differs");
  // The closed byte binder below validates the complete v3 shape. This local
  // narrowing does not authenticate the intent or grant host authority.
  const expected = intent as unknown as BootstrapOwnedEntryIntentV3;
  if (
    expected.installed.directory !== native.installedDirectory ||
    expected.installed.source !== native.installedSource ||
    !same(expected.installed.files, native.installedFiles) ||
    evidenceApi.bootstrapInstalledFilesDigest(expected.installed.files) !==
      native.installedBuild
  )
    throw new Error("Owned installed source differs");
  const profile = {
    ...ref(launch.profile),
    base64: Buffer.from(launch.profile.bytes).toString("base64"),
  };
  const executable = expected.executable;
  const attempt = decode(launch.attempt);
  const journal = decode(launch.journal);
  const cold = decode(launch.coldProcess);
  if (
    !same(attempt, {
      kind: "owned-autoload-launch-attempt-v1",
      isolation: "NOT_PROVEN",
      nonce,
      old,
      executable: executable.path,
      executableSha256: executable.sha256,
      profile,
      sourceClosure: ref(launch.sourceClosure),
    }) ||
    !exact(
      journal,
      "kind,nonce,process,executable,executableSha256,attempt,threadId,phase,isolation",
    ) ||
    !Number.isSafeInteger(journal["threadId"]) ||
    Number(journal["threadId"]) <= 0 ||
    !same(journal, {
      kind: "owned-autoload-created-process-v1",
      nonce,
      process: launch.process,
      executable: executable.path,
      executableSha256: executable.sha256,
      attempt: ref(launch.attempt),
      threadId: journal["threadId"],
      phase: "created-suspended",
      isolation: "NOT_PROVEN",
    }) ||
    !same(cold, {
      ...launch.process,
      exe: executable.path,
      executableSha256: executable.sha256,
      nonce,
      phase: "created-suspended",
      isolation: "NOT_PROVEN",
    }) ||
    !same(decode(launch.provisionReceipt), {
      kind: "owned-autoload-provision-bound-v1",
      isolation: "NOT_PROVEN",
      nonce,
      old,
      process: launch.process,
      ...lifecycle,
      beforeSha256: launch.provisionBackup.sha256,
      backup: ref(launch.provisionBackup),
      after: ref(launch.provision),
    })
  )
    throw new Error("Original owned process/provision journals differ");
  for (const [actual, required] of [
    [launch.intent.nativePath, native.paths.intent],
    [launch.profile.nativePath, native.paths.profile],
    [launch.profileBackup.nativePath, native.paths.profileBackup],
    [launch.provision.nativePath, native.paths.provision],
    [launch.attempt.nativePath, native.paths.launchAttempt],
    [launch.journal.nativePath, native.paths.launchJournal],
    [launch.sourceClosure.nativePath, native.paths.sourceClosure],
  ])
    if (actual !== required)
      throw new Error("Original owned launch path differs");
  return expected;
}

/** One-shot private controller. Data transcripts never recreate its live witness. */
export function createOwnedFusionBootstrap(
  old: ControlledProcess,
  ports: OwnedFusionBootstrapPorts,
) {
  const native = ports.native;
  const oldProcess = Object.freeze({ ...old });
  const lifecycle = structuredClone(ports.lifecycle);
  const qualifiedPackagePins = Object.freeze({
    directory: native.installedDirectory,
    source: native.installedSource,
    build: native.installedBuild,
    files: Object.freeze({ ...native.installedFiles }),
  });
  let attempted = false;
  type Witness = {
    lease: ControlledFusionLease;
    prepared: PreparedOwnedLaunch;
    rebound: ControlledRebindWitness;
    process: ControlledProcess;
    files: readonly ControlledFile[];
    expected: BootstrapOwnedEntryIntentV3;
    evidence: BootstrapOwnedEntryOriginals;
    revoked: boolean;
  };
  const originals = new WeakMap<ControlledFusionBootstrapTranscript, Witness>();
  const preparedWitnesses = new WeakSet<object>();
  async function assertOriginalTranscript(
    transcript: ControlledFusionBootstrapTranscript,
  ) {
    const w = originals.get(transcript);
    if (!w || w.revoked || transcript.state !== "COMPLETED")
      throw new Error("Original owned controller required");
    try {
      if (
        native.installedDirectory !== qualifiedPackagePins.directory ||
        native.installedSource !== qualifiedPackagePins.source ||
        native.installedBuild !== qualifiedPackagePins.build ||
        !same(native.installedFiles, qualifiedPackagePins.files)
      )
        throw new Error("Original owned source pins changed");
      sync(() => w.lease.fence());
      sync(() => w.prepared.fence());
      sync(() => w.rebound.fence());
      await w.lease.assertCurrent();
      await w.prepared.assertCurrent();
      await native.assertSource();
      await native.assertProcess(w.process);
      await w.rebound.assertCurrent();
      for (const file of w.files) await native.assertOriginal(file);
      await startupApi.verifyControlledStartupInputs(w.prepared.startupInputs);
      sync(() => w.lease.fence());
      sync(() => w.prepared.fence());
      sync(() => w.rebound.fence());
    } catch (error) {
      w.revoked = true;
      throw error;
    }
  }
  return Object.freeze({
    assertOriginalTranscript,
    async prepareOriginalWitness(
      transcript: ControlledFusionBootstrapTranscript,
    ) {
      await assertOriginalTranscript(transcript);
      const w = originals.get(transcript)!;
      const mapped = native.captureSynchronousFence(w.files);
      await assertOriginalTranscript(transcript);
      const witness = Object.freeze({
        context: Object.freeze({
          nonce: w.expected.nonce,
          process: Object.freeze({ ...w.process }),
          installedDirectory: native.installedDirectory,
          installedSource: native.installedSource,
          installedBuild: native.installedBuild,
          nativePathMappings: Object.freeze({ ...native.nativePathMappings }),
          originalRefs: Object.freeze(
            w.files.map((file) => Object.freeze(ref(file))),
          ),
        }),
        fence() {
          if (w.revoked) throw new Error("Owned window revoked");
          try {
            sync(() => w.lease.fence());
            sync(() => w.prepared.fence());
            sync(() => w.rebound.fence());
            sync(mapped);
            sync(() => w.lease.fence());
          } catch (error) {
            w.revoked = true;
            throw error;
          }
        },
      });
      witness.fence();
      preparedWitnesses.add(witness);
      return witness;
    },
    assertPreparedWitness(witness: { fence(): void }) {
      if (!preparedWitnesses.has(witness))
        throw new Error("Foreign owned witness");
      witness.fence();
    },
    async readOriginalIntent(transcript: ControlledFusionBootstrapTranscript) {
      await assertOriginalTranscript(transcript);
      return structuredClone(originals.get(transcript)!.expected);
    },
    async readOriginalEvidence(
      transcript: ControlledFusionBootstrapTranscript,
    ) {
      await assertOriginalTranscript(transcript);
      return structuredClone(originals.get(transcript)!.evidence);
    },
    async readOriginalTranscriptReference(
      transcript: ControlledFusionBootstrapTranscript,
    ) {
      await assertOriginalTranscript(transcript);
      const file = originals
        .get(transcript)!
        .files.find((file) => file.nativePath === native.paths.transcript);
      if (!file) throw new Error("Original owned transcript missing");
      return copy(file);
    },
    async run(
      signal?: AbortSignal,
    ): Promise<ControlledFusionBootstrapTranscript> {
      if (attempted) throw new Error("Owned bootstrap cannot be replayed");
      attempted = true;
      const nonce = randomBytes(16).toString("hex");
      const phases: string[] = [];
      const files: ControlledFile[] = [];
      let process: ControlledProcess | null = null;
      let lease: ControlledFusionLease | undefined;
      let prepared: PreparedOwnedLaunch | undefined;
      let transcriptAttempted = false;
      const keep = (file: ControlledFile) => {
        const retained = copy(file);
        files.push(retained);
        return retained;
      };
      const fence = async () => {
        if (signal?.aborted)
          throw new Error("Owned bootstrap cancelled; no replay");
        if (!lease) throw new Error("Original owned lease required");
        sync(() => lease!.fence());
        await lease.assertCurrent();
        sync(() => lease!.fence());
        if (prepared) {
          sync(() => prepared!.fence());
          await prepared.assertCurrent();
          sync(() => prepared!.fence());
        }
      };
      const transcript = (
        state: "COMPLETED" | "UNKNOWN",
        error: string | null,
      ) =>
        Object.freeze({
          kind: "controlled-fusion-bootstrap-transcript-v1" as const,
          mode: "owned-autoload-v1" as const,
          authority: "NONE" as const,
          state,
          nonce,
          old: oldProcess,
          process,
          phases: Object.freeze([...phases]),
          references: Object.freeze(files.map(ref)),
          error,
        });
      try {
        lease = await ports.acquireExclusiveLifecycleLease();
        await fence();
        await lease.retireOldNormally(oldProcess);
        await native.confirmDead(oldProcess);
        await fence();
        phases.push("old-death-os-confirmed");
        keep(
          await ports.qualifyNativeInstallationAfterDeath({
            old: oldProcess,
            qualifiedPackagePins,
          }),
        );
        await fence();
        await native.preflight();
        await native.assertSource();
        await fence();
        prepared = await ports.prepareBeforeLaunch({
          old: oldProcess,
          lease,
          qualifiedPackagePins,
        });
        await fence();
        startupApi.assertControlledStartupInputs(prepared.startupInputs);
        await startupApi.verifyControlledStartupInputs(prepared.startupInputs);
        if (!prepared.discoveryOriginals.length)
          throw new Error("Original discovery closure required");
        const startup = startupApi.readControlledStartupInputs(
          prepared.startupInputs,
        );
        const userProfileDirectory = path.win32.dirname(native.paths.profile);
        const canonical = (name: string) =>
          path.win32.normalize(name).toLowerCase();
        if (
          startup.expected.installedDirectory !== native.installedDirectory ||
          startup.expected.installedManifestHash !==
            native.installedFiles["AutodeskFusionMCP.manifest"] ||
          !same(
            startup.expected.autorunPaths.map(canonical),
            [
              path.win32.join(
                path.win32.dirname(userProfileDirectory),
                "PythonAutorunModuleinfo",
              ),
              path.win32.join(userProfileDirectory, "PythonAutorunModuleinfo"),
            ].map(canonical),
          )
        )
          throw new Error(
            "Original owned startup input paths or source differ",
          );
        for (const file of [...startup.files, ...prepared.discoveryOriginals])
          keep(file);
        await fence();
        phases.push("original-startup-discovery-fences-held");
        const launch = await prepared.launchAfterDeath(oldProcess, nonce);
        process = Object.freeze({ ...launch.process });
        for (const key of [
          "attempt",
          "journal",
          "sourceClosure",
          "profile",
          "profileBackup",
          "provision",
          "provisionBackup",
          "provisionReceipt",
          "coldProcess",
          "intent",
        ] as const)
          keep(launch[key]);
        const expected = verifyLaunch(
          launch,
          oldProcess,
          nonce,
          native,
          lifecycle,
        );
        await fence();
        await native.assertProcess(process);
        phases.push("owned-suspended-provision-intent-origin-bound");
        const receipts = await native.awaitReceipts(process);
        keep(receipts.entry);
        keep(receipts.returned);
        await fence();
        const evidence: BootstrapOwnedEntryOriginals = {
          intent: launch.intent,
          profile: launch.profile,
          provision: launch.provision,
          entry: receipts.entry,
          returned: receipts.returned,
        };
        const fork = path.win32.join(
          native.installedDirectory,
          "AutodeskFusionMCP.py",
        );
        const bound = evidenceApi.bindOwnedBootstrapEntryEvidence(
          expected,
          evidence,
          fork,
        );
        if (!bound) throw new Error("Original owned entry receipts differ");
        assertOwnedBootstrapStartupData(
          bound.startupAudit,
          startup.expected,
          startup.files,
        );
        const rebound = await ports.observeNativeRebound({
          old: oldProcess,
          launch,
          qualifiedPackagePins,
        });
        if (!same(rebound.process, process))
          throw new Error("Owned rebound process differs");
        keep(rebound.reference);
        await rebound.assertCurrent();
        sync(() => rebound.fence());
        await fence();
        phases.push("owned-entry-audit-return-and-native-generation-bound");
        const result = transcript("COMPLETED", null);
        transcriptAttempted = true;
        const transcriptBytes = Buffer.from(JSON.stringify(result) + "\n");
        const persisted = keep(
          await native.publishOriginal(
            native.paths.transcript,
            transcriptBytes,
          ),
        );
        if (
          persisted.nativePath !== native.paths.transcript ||
          !Buffer.from(persisted.bytes).equals(transcriptBytes)
        )
          throw new Error("Original owned transcript publication differs");
        await fence();
        await rebound.assertCurrent();
        originals.set(result, {
          lease,
          prepared,
          rebound,
          process,
          files: Object.freeze([...files]),
          expected: structuredClone(expected),
          evidence: structuredClone(evidence),
          revoked: false,
        });
        await assertOriginalTranscript(result);
        return result;
      } catch (error) {
        const diagnostic =
          error instanceof ControlledFusionNativeError
            ? JSON.stringify({
                message: error.message,
                action: error.action,
                stdout: error.stdout,
                stderr: error.stderr,
              })
            : error instanceof Error
              ? error.message
              : "Owned outcome unproven";
        const result = transcript("UNKNOWN", diagnostic);
        if (!transcriptAttempted) {
          transcriptAttempted = true;
          try {
            await native.publishOriginal(
              native.paths.transcript,
              Buffer.from(JSON.stringify(result) + "\n"),
            );
          } catch {
            /* Original partial failure remains UNKNOWN; never overwrite/retry. */
          }
        }
        return result;
      }
    },
  });
}
