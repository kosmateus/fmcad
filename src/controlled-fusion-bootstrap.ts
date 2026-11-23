import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  BootstrapEntryIntent,
  BootstrapEntryOriginals,
} from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
const load = createRequire(__filename);
const { bindBootstrapEntryEvidence } = load(
  "./dist/node-adapters/execution/bootstrap-entry-evidence",
) as typeof import("../packages/node-adapters/src/execution/bootstrap-entry-evidence");
const { planControlledFusionAutoload, matchesControlledFusionAutoload } = load(
  "./dist/node-adapters/execution/fusion-bootstrap-autoload",
) as typeof import("../packages/node-adapters/src/execution/fusion-bootstrap-autoload");
import type {
  ControlledProcess,
  ControlledFile,
  ControlledNativeAdapter,
  ControlledLaunch,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";
const { ControlledFusionNativeError } = load(
  "./dist/node-adapters/execution/controlled-fusion-launch",
) as typeof import("../packages/node-adapters/src/execution/controlled-fusion-launch");

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  Buffer.from(JSON.stringify(value) + "\n", "utf8");
const sameProcess = (a: ControlledProcess, b: ControlledProcess) =>
  a.pid === b.pid && a.birth === b.birth;
const reference = (file: ControlledFile) => ({
  nativePath: file.nativePath,
  sha256: file.sha256,
  identity: file.identity,
});
function synchronous(fence: () => void): void {
  const result: unknown = fence();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error(
      "Synchronous controlled fence must not return a Promise or flag",
    );
  }
}
function frozenFile(file: ControlledFile): ControlledFile {
  return Object.freeze({ ...file, bytes: Buffer.from(file.bytes) });
}

/** Actual held resource-safe/exclusive ingress lease supplied by trusted ROOT. */
export interface ControlledFusionLease {
  /** Immediate ROOT-owned owner/generation/revocation assertion, not OS polling. */
  fence(): void;
  assertCurrent(): Promise<void>;
  /** Supported lifecycle retirement, never force termination or blind replay. */
  retireOldNormally(old: ControlledProcess): Promise<void>;
}
export interface ControlledRebindWitness {
  readonly process: ControlledProcess;
  readonly reference: ControlledFile;
  /** Recheck the supported native generation/provision fence, not a JSON flag. */
  assertCurrent(): Promise<void>;
  fence(): void;
}
export interface ControlledStartObservation {
  readonly process: ControlledProcess;
  readonly selectedEntry: string;
  readonly reference: ControlledFile;
}
export interface ControlledQualifiedPackagePins {
  readonly directory: string;
  readonly source: string;
  readonly build: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface ControlledFusionBootstrapPorts {
  readonly native: ControlledNativeAdapter;
  acquireExclusiveLifecycleLease(): Promise<ControlledFusionLease>;
  /** Explicit qualified install/pin update; never smuggle source/build changes into rebind. */
  qualifyNativeInstallationAfterDeath(input: {
    old: ControlledProcess;
    qualifiedPackagePins: ControlledQualifiedPackagePins;
  }): Promise<ControlledFile>;
  rebindNative(input: {
    old: ControlledProcess;
    launched: ControlledLaunch;
    profile: ControlledFile;
    qualifiedPackagePins: ControlledQualifiedPackagePins;
  }): Promise<ControlledRebindWitness>;
  /** Fresh exact-host manager preparation WITHOUT starting an entry. */
  prepareExactHost(input: {
    process: ControlledProcess;
    entry: string;
  }): Promise<ControlledStartObservation>;
  /**
   * ROOT's exact-PID/birth fresh dialog/selection observation followed by ONE
   * supported input. An input delivery is not a startup postcondition.
   */
  startReviewedFork(input: {
    process: ControlledProcess;
    entry: string;
    intent: ControlledFile;
  }): Promise<ControlledStartObservation>;
}
export interface ControlledFusionBootstrapTranscript {
  readonly kind: "controlled-fusion-bootstrap-transcript-v1";
  readonly authority: "NONE";
  readonly state: "COMPLETED" | "UNKNOWN";
  readonly nonce: string;
  readonly old: ControlledProcess;
  readonly process: ControlledProcess | null;
  readonly phases: readonly string[];
  readonly references: readonly ReturnType<typeof reference>[];
  readonly error: string | null;
}

/**
 * A one-shot supported operator, not admission/activation. Only trusted local
 * ROOT composition may construct ports. There is deliberately no caller flag,
 * automatic release, process rediscovery, second launch, receipt retry or repair.
 */
export function createControlledFusionBootstrap(
  old: ControlledProcess,
  ports: ControlledFusionBootstrapPorts,
) {
  const native = ports.native;
  const oldProcess = Object.freeze({ ...old });
  const qualifiedPackagePins: ControlledQualifiedPackagePins = Object.freeze({
    directory: native.installedDirectory,
    source: native.installedSource,
    build: native.installedBuild,
    files: Object.freeze({ ...native.installedFiles }),
  });
  let invoked = false;
  const originals = new WeakMap<
    ControlledFusionBootstrapTranscript,
    {
      lease: ControlledFusionLease;
      rebind: ControlledRebindWitness;
      process: ControlledProcess;
      files: readonly ControlledFile[];
      evidence: BootstrapEntryOriginals;
      expected: BootstrapEntryIntent;
      revoked: boolean;
    }
  >();
  const preparedWitnesses = new WeakSet<object>();
  async function assertOriginalTranscript(
    transcript: ControlledFusionBootstrapTranscript,
  ): Promise<void> {
    const witness = originals.get(transcript);
    if (!witness || witness.revoked || transcript.state !== "COMPLETED")
      throw new Error("Original held controlled bootstrap witness required");
    try {
      await witness.lease.assertCurrent();
      await native.assertSource();
      await native.assertProcess(witness.process);
      await witness.rebind.assertCurrent();
      for (const file of witness.files) await native.assertOriginal(file);
      await witness.lease.assertCurrent();
    } catch (error) {
      witness.revoked = true;
      throw error;
    }
  }
  return Object.freeze({
    assertOriginalTranscript,
    /** Full native validation at every new preparation; no cached decision/TTL. */
    async prepareOriginalWitness(
      transcript: ControlledFusionBootstrapTranscript,
    ) {
      await assertOriginalTranscript(transcript);
      const original = originals.get(transcript);
      if (!original) throw new Error("Original bootstrap unavailable");
      const mappedFence = native.captureSynchronousFence(original.files);
      await assertOriginalTranscript(transcript);
      const witness = Object.freeze({
        context: Object.freeze({
          nonce: transcript.nonce,
          process: Object.freeze({ ...original.process }),
          installedDirectory: native.installedDirectory,
          installedSource: native.installedSource,
          installedBuild: native.installedBuild,
          nativePathMappings: Object.freeze({ ...native.nativePathMappings }),
          originalRefs: Object.freeze(
            original.files.map((file) => Object.freeze(reference(file))),
          ),
        }),
        fence() {
          if (original.revoked)
            throw new Error("Original controlled window revoked");
          try {
            synchronous(() => original.lease.fence());
            synchronous(() => original.rebind.fence());
            synchronous(mappedFence);
            synchronous(() => original.lease.fence());
          } catch (error) {
            original.revoked = true;
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
        throw new Error("Foreign controlled witness");
      witness.fence();
    },
    async readOriginalIntent(
      transcript: ControlledFusionBootstrapTranscript,
    ): Promise<BootstrapEntryIntent> {
      await assertOriginalTranscript(transcript);
      const original = originals.get(transcript);
      if (!original) throw new Error("Original bootstrap intent unavailable");
      return structuredClone(original.expected);
    },
    async readOriginalTranscriptReference(
      transcript: ControlledFusionBootstrapTranscript,
    ): Promise<ControlledFile> {
      await assertOriginalTranscript(transcript);
      const witness = originals.get(transcript);
      const original = witness?.files.find(
        (file) => file.nativePath === native.paths.transcript,
      );
      if (!original)
        throw new Error("Original persisted transcript unavailable");
      return frozenFile(original);
    },
    /** Copies of original native paths/bytes, only while the private window holds. */
    async readOriginalEvidence(
      transcript: ControlledFusionBootstrapTranscript,
    ): Promise<BootstrapEntryOriginals> {
      await assertOriginalTranscript(transcript);
      const witness = originals.get(transcript);
      if (!witness) throw new Error("Original bootstrap witness unavailable");
      return Object.fromEntries(
        Object.entries(witness.evidence).map(([key, file]) => [
          key,
          { nativePath: file.nativePath, bytes: Buffer.from(file.bytes) },
        ]),
      ) as unknown as BootstrapEntryOriginals;
    },
    async run(
      signal?: AbortSignal,
    ): Promise<ControlledFusionBootstrapTranscript> {
      if (invoked)
        throw new Error("Controlled bootstrap attempt cannot be replayed");
      invoked = true;
      const nonce = randomBytes(16).toString("hex");
      const phases: string[] = [];
      const files: ControlledFile[] = [];
      let process: ControlledProcess | null = null;
      let lease: ControlledFusionLease | undefined;
      let transcriptWriteAttempted = false;
      const cancelled = () => {
        if (signal?.aborted)
          throw new Error("Controlled bootstrap cancelled; no replay");
      };
      const fence = async () => {
        cancelled();
        if (!lease) throw new Error("Held lease required");
        await lease.assertCurrent();
      };
      const keep = (file: ControlledFile) => {
        if (sha(file.bytes) !== file.sha256)
          throw new Error("Original bytes differ");
        const retained = frozenFile(file);
        files.push(retained);
        return retained;
      };
      const transcript = (
        state: "COMPLETED" | "UNKNOWN",
        error: string | null,
      ): ControlledFusionBootstrapTranscript =>
        Object.freeze({
          kind: "controlled-fusion-bootstrap-transcript-v1",
          authority: "NONE",
          state,
          nonce,
          old: oldProcess,
          process,
          phases: Object.freeze([...phases]),
          references: Object.freeze(
            files.map((file) => Object.freeze(reference(file))),
          ),
          error,
        });
      try {
        cancelled();
        lease = await ports.acquireExclusiveLifecycleLease();
        await fence();
        phases.push("private-resource-safe-lease-held");
        await lease.retireOldNormally(oldProcess);
        phases.push("supported-normal-retirement-requested");
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
        phases.push("qualified-native-install-pins-fenced");
        const before = await native.readProfileAfterDeath(oldProcess);
        const forkEntry = path.win32.join(
          native.installedDirectory,
          "AutodeskFusionMCP.py",
        );
        const plan = planControlledFusionAutoload(before.bytes, forkEntry);
        await fence();
        const applied = await native.applyProfileAfterDeath(
          oldProcess,
          before,
          plan.registrationBytes(),
        );
        let profile = applied.profile;
        keep(applied.backup);
        if (profile.sha256 !== plan.plannedSha256)
          throw new Error("All-autoload-off profile differs");
        phases.push("original-profile-backed-up-all-autoload-off");
        await fence();
        const launch = await native.launch(oldProcess, profile, nonce);
        process = Object.freeze({ ...launch.process });
        if (
          process.pid === oldProcess.pid ||
          process.birth === oldProcess.birth
        )
          throw new Error("Launch did not create a distinct process identity");
        keep(launch.attempt);
        keep(launch.journal);
        keep(launch.sourceClosure);
        phases.push("create-process-origin-bound");
        await fence();
        await native.assertProcess(process);
        const rebind = await ports.rebindNative({
          old: oldProcess,
          launched: launch,
          profile,
          qualifiedPackagePins,
        });
        if (!sameProcess(rebind.process, process))
          throw new Error("Native rebind targets another process");
        keep(rebind.reference);
        await rebind.assertCurrent();
        await fence();
        phases.push("supported-native-generation-rebound");
        const preparedUi = await ports.prepareExactHost({
          process,
          entry: forkEntry,
        });
        if (
          !sameProcess(preparedUi.process, process) ||
          path.win32.normalize(preparedUi.selectedEntry).toLowerCase() !==
            forkEntry.toLowerCase()
        )
          throw new Error("Unexpected exact-host manager preparation");
        keep(preparedUi.reference);
        await fence();
        await rebind.assertCurrent();
        // Opening the vendor manager can normalize its registration. Bind the
        // actual ALL-OFF bytes after that supported preparation, before intent.
        profile = keep(await native.readOriginal(native.paths.profile));
        if (!matchesControlledFusionAutoload(profile.bytes, forkEntry))
          throw new Error(
            "Manager preparation changed the all-autoload-off boundary",
          );
        phases.push("fresh-manager-prepared-actual-all-off-profile-rebound");
        const expected: BootstrapEntryIntent = {
          kind: "fmcad-bootstrap-entry-intent",
          version: 1,
          nonce,
          process,
          purpose: "isolated-stdout-v1",
          engineVersion: 2,
          installed: {
            directory: native.installedDirectory,
            source: native.installedSource,
            files: native.installedFiles,
          },
          profile: { path: profile.nativePath, sha256: profile.sha256 },
          receipts: {
            directory: native.paths.receiptDirectory,
            entry: path.win32.basename(native.paths.entry),
            returned: path.win32.basename(native.paths.returned),
          },
        };
        const intent = keep(
          await native.publishOriginal(native.paths.intent, json(expected)),
        );
        phases.push("private-intent-published-after-rebind");
        await fence();
        await rebind.assertCurrent();
        const observed = await ports.startReviewedFork({
          process,
          entry: forkEntry,
          intent,
        });
        if (
          !sameProcess(observed.process, process) ||
          path.win32.normalize(observed.selectedEntry).toLowerCase() !==
            forkEntry.toLowerCase()
        )
          throw new Error("Unexpected exact-host start observation");
        keep(observed.reference);
        phases.push("one-fresh-exact-host-manual-start");
        await fence();
        const receipts = await native.awaitReceipts(process);
        const entry = keep(receipts.entry),
          returned = keep(receipts.returned);
        const evidence: BootstrapEntryOriginals = {
          intent,
          profile,
          entry,
          returned,
        };
        if (!bindBootstrapEntryEvidence(expected, evidence, forkEntry))
          throw new Error("Original bootstrap phases are unproven");
        phases.push("original-entry-and-return-bound");
        await fence();
        await rebind.assertCurrent();
        await native.assertSource();
        await native.assertProcess(process);
        for (const file of files) await native.assertOriginal(file);
        const completed = transcript("COMPLETED", null);
        transcriptWriteAttempted = true;
        const persisted = keep(
          await native.publishOriginal(
            native.paths.transcript,
            json(completed),
          ),
        );
        await fence();
        await native.assertOriginal(persisted);
        originals.set(completed, {
          lease,
          rebind,
          process,
          files: [...files],
          evidence,
          expected: structuredClone(expected),
          revoked: false,
        });
        // Lease remains held. ROOT must retain this object and reassert throughout
        // its qualified lifetime, then decide its own authenticated consumption.
        return completed;
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
              : "Unknown native outcome";
        const unknown = transcript("UNKNOWN", diagnostic);
        if (!transcriptWriteAttempted) {
          transcriptWriteAttempted = true;
          try {
            await native.publishOriginal(
              native.paths.transcript,
              json(unknown),
            );
          } catch {
            /* Preserve originals and any partial write; never retry. */
          }
        }
        return unknown;
      }
    },
  });
}
