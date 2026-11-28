/** Private local composition contracts. None of these DTOs is an SDK grant. */
export interface ControlledProcess {
  readonly pid: number;
  readonly birth: string;
}
export interface ControlledFile {
  readonly nativePath: string;
  readonly sha256: string;
  /** Stable native volume/file identity and creation/write metadata. */
  readonly identity: string;
  readonly bytes: Uint8Array;
}
export interface ControlledLaunchPaths {
  readonly profile: string;
  readonly profileBackup: string;
  readonly intent: string;
  readonly receiptDirectory: string;
  readonly entry: string;
  readonly returned: string;
  readonly launchJournal: string;
  readonly launchAttempt: string;
  readonly sourceClosure: string;
  readonly transcript: string;
  readonly provision: string;
}
export interface OwnedAutoloadLaunchPaths extends ControlledLaunchPaths {
  readonly identityAttempt: string;
  readonly identityJournal: string;
  readonly identityPreparation: string;
}
export interface ControlledLaunch {
  readonly process: ControlledProcess;
  readonly journal: ControlledFile;
  readonly attempt: ControlledFile;
  readonly sourceClosure: ControlledFile;
}
/** Suspended-process originals only; completion does not prove isolated startup. */
export interface OwnedAutoloadLaunch extends ControlledLaunch {
  readonly profile: ControlledFile;
  readonly profileBackup: ControlledFile;
  readonly provision: ControlledFile;
  readonly provisionBackup: ControlledFile;
  readonly provisionReceipt: ControlledFile;
  readonly coldProcess: ControlledFile;
  readonly intent: ControlledFile;
  readonly startupProven: false;
}
/** Bounded process preparation evidence; it is not Identity service readiness. */
export interface OwnedIdentityPreparation {
  readonly state: "PREPARATION_ONLY_NOT_SERVICE_READY";
  readonly origin: "spawned" | "adopted";
  readonly process: ControlledProcess;
  readonly executable: string;
  readonly sha256: string;
  readonly version: string;
  readonly arguments: readonly string[];
  readonly commandLine: string;
  readonly inputIdleCode: 0;
  readonly logEvent: {
    readonly pid: number;
    readonly timestamp: string;
    readonly offset: number;
    readonly line: string;
  };
}
export interface OwnedIdentityPreparationLaunch extends OwnedAutoloadLaunch {
  readonly identityAttempt: ControlledFile;
  readonly identityJournal: ControlledFile;
  readonly identityPreparationFile: ControlledFile;
  readonly identityPreparation: OwnedIdentityPreparation;
}
export interface ControlledNativeAdapter {
  readonly paths: ControlledLaunchPaths;
  readonly installedDirectory: string;
  readonly installedSource: string;
  readonly installedBuild: string;
  readonly installedFiles: Readonly<Record<string, string>>;
  readonly nativePathMappings: Readonly<Record<string, string>>;
  preflight(): Promise<void>;
  /** Native ONE WM_CLOSE to the exact unique vendor window, then bounded OS wait. */
  requestNormalCloseAndWait(process: ControlledProcess): Promise<void>;
  confirmDead(process: ControlledProcess): Promise<void>;
  readProfileAfterDeath(process: ControlledProcess): Promise<ControlledFile>;
  applyProfileAfterDeath(
    process: ControlledProcess,
    original: ControlledFile,
    bytes: Uint8Array,
  ): Promise<{ profile: ControlledFile; backup: ControlledFile }>;
  launch(
    process: ControlledProcess,
    profile: ControlledFile,
    nonce: string,
  ): Promise<ControlledLaunch>;
  assertProcess(process: ControlledProcess): Promise<void>;
  readOriginal(nativePath: string): Promise<ControlledFile>;
  publishOriginal(
    nativePath: string,
    bytes: Uint8Array,
  ): Promise<ControlledFile>;
  assertOriginal(file: ControlledFile): Promise<void>;
  assertSource(): Promise<void>;
  /** Full mapped bytes/identity only; NOT a synchronous native PID/DACL query. */
  captureSynchronousFence(files: readonly ControlledFile[]): () => void;
  awaitReceipts(process: ControlledProcess): Promise<{
    entry: ControlledFile;
    returned: ControlledFile;
  }>;
}
