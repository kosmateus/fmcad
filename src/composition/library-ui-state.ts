import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { digest, digestText, uuid } from "./library-ui-domain";
import type {
  UiTarget,
  UiLease,
  UiWindow,
  UiCommand,
  UiProfileCandidate,
} from "./library-ui-domain";
import type { UiHostResult } from "./library-ui-host";
const hostPlatform = createRequire(__filename)("../config-platform") as {
  resolveRuntimePaths(input: { anchor: string }): { state: string };
};
const OBSERVATION_TTL_MS = 30000;
const MAX_STATE_BYTES = 512 * 1024;
export interface UiLeaseBinding {
  requestId: string;
  operationId: string;
  idHash: string;
  target: UiTarget;
}
export interface UiWatcherRequest {
  requestId: string;
  expectedIdentity: UiTarget;
  intent: string;
  profileId: string;
  lease?: UiLease | undefined;
  leaseBinding?: UiLeaseBinding | undefined;
  timeBudgetMs?: number | undefined;
  checkHostProcess?: boolean | undefined;
}
export interface UiProcessIdentity {
  processId?: number | undefined;
  processStartTicks?: string | undefined;
  mainWindowHandle?: number | undefined;
  fusionVersion?: string | undefined;
  osBuild?: string | undefined;
  locale?: string | undefined;
}
export interface UiActionResult extends UiHostResult, UiProcessIdentity {
  truncated?: boolean | undefined;
  success?: boolean | undefined;
  operation?: string | undefined;
  observationId?: (string | null) | undefined;
  requestId?: string | undefined;
  windows?: UiWindow[] | undefined;
  profiles?:
    | (Omit<UiProfileCandidate, "windowHandle" | "fingerprint"> &
        Partial<Pick<UiProfileCandidate, "windowHandle" | "fingerprint">>)[]
    | undefined;
  identityVerified?: boolean | undefined;
  resolutionStatus?: string | undefined;
  profileId?: string | undefined;
  dialogClosed?: (boolean | null) | undefined;
  nativeCommandId?: (string | null) | undefined;
  activeCommand?: (UiCommand | null) | undefined;
  idle?: (boolean | null) | undefined;
  terminationReason?: (string | null) | undefined;
  terminationObservationAvailable?: (boolean | null) | undefined;
  modelUnchanged?: (boolean | null) | undefined;
  watcherState?: string | undefined;
  hostProcessStatus?: string | undefined;
  watcherResult?: (UiActionResult | null) | undefined;
  result?: (UiActionResult | null) | undefined;
}
export interface UiLifecycleBinding {
  lifecycleId: string;
  requestId: string;
  leaseHash: string | null;
  leaseIdHash: string;
  operationId: string;
  target: UiTarget;
  intent: string;
  profileId: string;
}
export interface UiLifecycleRecord extends UiLifecycleBinding {
  schemaVersion: number;
  state: string;
  startedAt: number;
  updatedAt: number;
  fusionProcess: UiProcessIdentity | null;
  hostProcess: unknown;
  result: UiActionResult | null;
  continuationOf?: (string | null) | undefined;
  renewalAuthorized?: boolean | undefined;
  originalLeaseIdHash?: (string | null) | undefined;
}
export interface UiLifecyclePatch {
  state?: string;
  fusionProcess?: UiProcessIdentity | null;
  hostProcess?: unknown | undefined;
  result?: UiActionResult | null;
  continuationOf?: (string | null) | undefined;
  renewalAuthorized?: boolean | undefined;
  originalLeaseIdHash?: (string | null) | undefined;
  operationId?: string;
  nativeCommandId?: string | undefined;
}
export interface UiObservation extends UiProcessIdentity {
  requestId: string;
  leaseHash: string;
  intent: string | null;
  target: UiTarget;
  backend?: string | undefined;
  sessionFingerprint?: string | undefined;
  activeCommand?: (UiCommand | null) | undefined;
  windows: UiWindow[];
  truncated: boolean;
  observationId: string;
  createdAt: number;
  expiresAt: number;
}
export interface UiObservationClaim {
  observationId: string;
  requestId: string;
  state: string;
  claimedAt: number;
  result?: UiActionResult | undefined;
  finishedAt?: number | undefined;
}
export type UiObservationLookup =
  | { status: "fresh"; directory: string; record: UiObservation }
  | {
      status: "used" | "unknown";
      directory: string;
      result?: UiActionResult | undefined;
    }
  | { status: "expired" | "missing"; directory: string };
export interface UiStateDependencies {
  stateDir?: (string | null) | undefined;
  now?: (() => number) | undefined;
}
export interface UiLifecycleWrite {
  status: string;
  file: string;
  record?: UiLifecycleRecord | undefined;
}
export interface UiStateFileHandle {
  writeFile(contents: string): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface UiStateFilePort {
  mkdir(
    directory: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  lstat(
    file: string,
  ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  chmod(file: string, mode: number): Promise<void>;
  open(file: string, flags: string, mode: number): Promise<UiStateFileHandle>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  rename(source: string, target: string): Promise<void>;
  unlink(file: string): Promise<void>;
  writeFile(
    file: string,
    contents: string,
    options: { mode: number },
  ): Promise<void>;
}
export function createUiStateStore(files: UiStateFilePort = fs) {
  function stateDirectory(dependencies: UiStateDependencies = {}) {
    return (
      dependencies.stateDir ||
      process.env["FMCAD_UI_STATE_DIR"] ||
      path.join(
        hostPlatform.resolveRuntimePaths({ anchor: __filename }).state,
        "ui",
      )
    );
  }

  async function ensureStateDirectory(dependencies: UiStateDependencies = {}) {
    const directory = stateDirectory(dependencies);
    await files.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await files.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("UI receipt path must be a real owned directory");
    await files.chmod(directory, 0o700).catch(() => {});
    return directory;
  }

  async function writeExclusive(file: string, value: unknown) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES)
      throw new Error("UI receipt exceeds its bounded size");
    const handle = await files.open(file, "wx", 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  const observationPath = (directory: string, id: string) =>
    path.join(directory, `observation-${id}.json`);
  const receiptPath = (directory: string, id: string) =>
    path.join(directory, `action-${id}.json`);

  function watcherLifecycleBinding(
    request: UiWatcherRequest,
  ): UiLifecycleBinding {
    const leaseBinding = request.leaseBinding ?? {
      requestId: request.lease!.requestId,
      operationId: request.lease!.operationId,
      idHash: digestText(request.lease!.id),
      target: request.lease!.target,
    };
    const leaseHash = request.lease ? digest(request.lease) : null;
    const target = {
      name: request.expectedIdentity.name,
      creationId: request.expectedIdentity.creationId ?? null,
      fileId: request.expectedIdentity.fileId ?? null,
      commandId: request.expectedIdentity.commandId ?? null,
    };
    const lifecycleId = digest([
      request.requestId,
      leaseBinding.idHash,
      target,
      request.intent,
      request.profileId,
    ]);
    return {
      lifecycleId,
      requestId: request.requestId,
      leaseHash,
      leaseIdHash: leaseBinding.idHash,
      operationId: leaseBinding.operationId,
      target,
      intent: request.intent,
      profileId: request.profileId,
    };
  }

  function watcherLifecyclePath(directory: string, lifecycleId: string) {
    return path.join(directory, `watcher-${lifecycleId}.json`);
  }

  async function writeWatcherLifecycle(
    directory: string,
    binding: UiLifecycleBinding,
    create: boolean,
    patch: UiLifecyclePatch = {},
  ): Promise<UiLifecycleWrite> {
    const file = watcherLifecyclePath(directory, binding.lifecycleId);
    let current: UiLifecycleRecord | undefined;
    try {
      current = JSON.parse(
        await files.readFile(file, "utf8"),
      ) as UiLifecycleRecord;
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") throw error;
    }
    if (create && current) return { status: "exists", record: current, file };
    if (!create && !current) return { status: "missing", file };
    if (
      current &&
      (current.lifecycleId !== binding.lifecycleId ||
        current.requestId !== binding.requestId ||
        current.leaseHash !== binding.leaseHash ||
        current.leaseIdHash !== binding.leaseIdHash ||
        current.intent !== binding.intent ||
        (current.operationId && current.operationId !== binding.operationId) ||
        current.profileId !== binding.profileId ||
        JSON.stringify(current.target) !== JSON.stringify(binding.target))
    ) {
      return { status: "identityMismatch", file };
    }
    if (current?.state === "finished")
      return { status: "finished", record: current, file };
    const now = Date.now();
    const next: UiLifecycleRecord = create
      ? {
          schemaVersion: 1,
          ...binding,
          state: "starting",
          startedAt: now,
          updatedAt: now,
          fusionProcess: patch.fusionProcess ?? null,
          hostProcess: null,
          result: null,
          continuationOf: patch.continuationOf ?? null,
          renewalAuthorized: patch.renewalAuthorized === true,
          originalLeaseIdHash: patch.originalLeaseIdHash ?? null,
        }
      : { ...current!, ...patch, updatedAt: now };
    const transitions: Record<string, string[]> = {
      starting: ["running", "finished", "unknown"],
      running: ["finished", "unknown"],
      unknown: [],
      finished: [],
    };
    if (
      !create &&
      patch.state &&
      patch.state !== current!.state &&
      !transitions[current!.state]?.includes(patch.state)
    )
      return { status: "invalidTransition", record: current, file };
    if (!create && current!.state === "finished")
      return { status: "finished", record: current, file };
    if (create) {
      await writeExclusive(file, next);
      return { status: "created", record: next, file };
    }
    const temp = `${file}.${process.pid}.${uuid()}.tmp`;
    const handle = await files.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await files.rename(temp, file);
    await files.chmod(file, 0o600).catch(() => {});
    return { status: "updated", record: next, file };
  }

  async function saveObservation(
    record: Omit<UiObservation, "observationId" | "createdAt" | "expiresAt">,
    dependencies: UiStateDependencies = {},
  ) {
    const directory = await ensureStateDirectory(dependencies);
    const observationId = uuid();
    const createdAt = (dependencies.now ?? Date.now)();
    const expiresAt = createdAt + OBSERVATION_TTL_MS;
    await writeExclusive(observationPath(directory, observationId), {
      ...record,
      observationId,
      createdAt,
      expiresAt,
    });
    return { observationId, expiresAt };
  }

  async function getObservation(
    id: string,
    dependencies: UiStateDependencies = {},
  ): Promise<UiObservationLookup> {
    const directory = await ensureStateDirectory(dependencies);
    const receipt = receiptPath(directory, id);
    try {
      const prior = JSON.parse(
        await files.readFile(receipt, "utf8"),
      ) as UiObservationClaim;
      return {
        status: prior.state === "complete" ? "used" : "unknown",
        directory,
        result: prior.result,
      };
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const record = JSON.parse(
        await files.readFile(observationPath(directory, id), "utf8"),
      ) as UiObservation;
      if (
        record.observationId !== id ||
        (dependencies.now ?? Date.now)() >= record.expiresAt
      ) {
        await files.unlink(observationPath(directory, id)).catch(() => {});
        return { status: "expired", directory };
      }
      return { status: "fresh", directory, record };
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code === "ENOENT") return { status: "missing", directory };
      throw error;
    }
  }

  async function claimObservation(
    id: string,
    loaded: { directory: string },
    requestId: string,
  ) {
    const record = {
      observationId: id,
      requestId,
      state: "in_progress",
      claimedAt: Date.now(),
    };
    await writeExclusive(receiptPath(loaded.directory, id), record);
    await files.unlink(observationPath(loaded.directory, id)).catch(() => {});
    return record;
  }

  async function finishObservation(
    id: string,
    loaded: { directory: string },
    claim: UiObservationClaim,
    result: UiActionResult,
  ) {
    const final = {
      ...claim,
      state: result.status === "unknown" ? "unknown" : "complete",
      result,
      finishedAt: Date.now(),
    };
    await files.writeFile(
      receiptPath(loaded.directory, id),
      JSON.stringify(final),
      { mode: 0o600 },
    );
    return final;
  }

  return {
    stateDirectory,
    ensureStateDirectory,
    writeExclusive,
    observationPath,
    receiptPath,
    watcherLifecycleBinding,
    watcherLifecyclePath,
    writeWatcherLifecycle,
    saveObservation,
    getObservation,
    claimObservation,
    finishObservation,
  };
}
export const {
  stateDirectory,
  ensureStateDirectory,
  writeExclusive,
  observationPath,
  receiptPath,
  watcherLifecycleBinding,
  watcherLifecyclePath,
  writeWatcherLifecycle,
  saveObservation,
  getObservation,
  claimObservation,
  finishObservation,
} = createUiStateStore();
