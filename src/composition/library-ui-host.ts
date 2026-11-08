import path from "node:path";
import { spawn } from "node:child_process";
import { redactDiagnostic } from "@fmcad/core";
import { createRequire } from "node:module";
const hostRequire = createRequire(__filename);
interface Platform {
  detectPlatform(): unknown;
  toWindowsPath(value: string, platform: unknown): string;
  resolveRuntimePaths(input: { anchor: string }): { assets: string };
}
const hostPlatform = hostRequire("../config-platform") as Platform;
export interface UiHostRequest extends Record<string, unknown> {
  timeBudgetMs?: number;
  requestId?: string;
  lifecycleId?: string;
}
export interface UiHostResult extends Record<string, unknown> {
  status?: string;
  requestId?: string;
  lifecycleId?: string;
  actionSubmitted?: boolean | null;
  operationOutcome?: string;
  unavailableEvidence?: string[];
  helperDiagnostic?: string;
}
interface HostStream {
  on(
    event: "data",
    callback: (chunk: { toString(encoding: "utf8"): string }) => void,
  ): unknown;
  unref?(): void;
}
export interface UiHostProcess {
  exitCode: number | null;
  kill(): unknown;
  unref?(): void;
  stdout: HostStream;
  stderr: HostStream;
  on(event: "error", callback: (error: Error) => void): unknown;
  on(event: "close", callback: (code: number | null) => void): unknown;
}
interface SpawnOptions {
  shell: false;
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
}
export interface UiHostDependencies {
  powershellPath?: string;
  helperPath?: string;
  runHost?: (
    mode: string,
    request: UiHostRequest,
  ) => UiHostResult | Promise<UiHostResult>;
  spawnHost?: (
    executable: string,
    args: string[],
    options: SpawnOptions,
  ) => UiHostProcess;
}
export interface UiHostHandle {
  child?: UiHostProcess;
  ready?: Promise<UiHostResult>;
  completion: Promise<UiHostResult>;
  stop(): Promise<UiHostResult | null>;
}
const spawnHost = (
  executable: string,
  args: string[],
  options: SpawnOptions,
): UiHostProcess => spawn(executable, args, options);
const MAX_HOST_OUTPUT_BYTES = 256 * 1024;
function parseMarked(textValue: string, marker: string): UiHostResult {
  const line = String(textValue || "")
    .split(/\r?\n/)
    .find((value) => value.startsWith(marker));
  if (!line) throw new Error(`Missing ${marker.trim()} response`);
  // Process markers retain their historical payload shape; command boundaries
  // independently check readiness ownership and snapshot/receipt evidence.
  return JSON.parse(line.slice(marker.length)) as UiHostResult;
}
function powershellExecutable(dependencies: UiHostDependencies = {}) {
  if (dependencies.powershellPath) return dependencies.powershellPath;
  if (
    process.platform === "win32" ||
    (process.platform === "linux" && process.env["WSL_DISTRO_NAME"])
  )
    return "powershell.exe";
  return null;
}

export function windowsPath(value: string) {
  const platform = hostPlatform;
  return platform.toWindowsPath(path.resolve(value), platform.detectPlatform());
}

export function stopTimedOutHostHelper(mode: string, child: UiHostProcess) {
  if (mode === "watch-status" || child.exitCode !== null) return false;
  child.kill();
  return true;
}

export function detachTimedOutWatcherStatusHelper(child: UiHostProcess) {
  child.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();
}

export function startHostHelper(
  mode: string,
  request: UiHostRequest,
  dependencies: UiHostDependencies = {},
): UiHostHandle {
  if (dependencies.runHost) {
    const completion = Promise.resolve().then(() =>
      dependencies.runHost!(mode, request),
    );
    return { completion, stop: async () => completion };
  }
  const executable = powershellExecutable(dependencies);
  if (!executable)
    return {
      completion: Promise.resolve({
        status: "unsupported",
        unavailableEvidence: [
          "No Windows Fusion UIAutomation host is available; no fallback is attempted.",
        ],
      }),
      stop: async () => null,
    };
  const script = windowsPath(
    dependencies.helperPath ||
      path.join(
        hostPlatform.resolveRuntimePaths({ anchor: __filename }).assets,
        "ui_dialog.ps1",
      ),
  );
  const wire = JSON.stringify(request);
  // Windows CreateProcess limits the entire command line to 32767 characters.
  // Leave room for executable/script paths and fixed switches before spawning.
  if (
    Buffer.byteLength(wire) > 16 * 1024 ||
    script.length + executable.length > 4096
  ) {
    return {
      completion: Promise.resolve({
        status: "blocked",
        actionSubmitted: false,
        operationOutcome: "notEvaluated",
        unavailableEvidence: [
          "UIA request exceeds the bounded Windows argv size.",
        ],
      }),
      stop: async () => null,
    };
  }
  const timeout = request.timeBudgetMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120000) {
    return {
      completion: Promise.resolve({
        status: "blocked",
        actionSubmitted: false,
        unavailableEvidence: [
          "UIA helper requires a finite positive deadline up to 120000 ms.",
        ],
      }),
      stop: async () => null,
    };
  }
  const encoded = Buffer.from(wire, "utf8").toString("base64");
  let child: UiHostProcess;
  try {
    child = (dependencies.spawnHost ?? spawnHost)(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Mode",
        mode,
        "-RequestBase64",
        encoded,
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (caught) {
    const error = caught as Error;
    return {
      completion: Promise.resolve({
        status: "unsupported",
        unavailableEvidence: [redactDiagnostic(error.message)],
      }),
      stop: async () => null,
    };
  }
  let acknowledgeReady: (receipt: UiHostResult) => void = () => {};
  const ready = new Promise<UiHostResult>((resolve) => {
    acknowledgeReady = resolve;
  });
  const completion = new Promise<UiHostResult>((resolve) => {
    let stdout = "",
      stderr = "",
      expired = false,
      oversized = false,
      settled = false;
    const limit = MAX_HOST_OUTPUT_BYTES;
    const timer = setTimeout(() => {
      expired = true;
      if (mode === "watch-status") {
        settled = true;
        detachTimedOutWatcherStatusHelper(child);
        resolve({
          status: "unknown",
          actionSubmitted: null,
          operationOutcome: "unknown",
          unavailableEvidence: [
            "read-only watcher status host query timed out; no process was stopped",
          ],
        });
      } else stopTimedOutHostHelper(mode, child);
    }, timeout);
    child.stdout.on("data", (chunk) => {
      if (settled || oversized) return;
      stdout += chunk.toString("utf8");
      if (mode === "watch" && stdout.includes("FMCAD_UI_WATCHER_READY ")) {
        try {
          const receipt = parseMarked(stdout, "FMCAD_UI_WATCHER_READY ");
          if (
            receipt.requestId === request.requestId &&
            receipt.lifecycleId === request.lifecycleId
          )
            acknowledgeReady(receipt);
        } catch {
          /* Wait for the complete readiness line. */
        }
      }
      if (Buffer.byteLength(stdout) > limit) {
        oversized = true;
        if (child.exitCode === null) child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (settled || oversized) return;
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > limit) {
        oversized = true;
        if (child.exitCode === null) child.kill();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        status: "unsupported",
        unavailableEvidence: [redactDiagnostic(error.message)],
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (expired) {
        resolve({
          status: "unknown",
          actionSubmitted: null,
          operationOutcome: "unknown",
          unavailableEvidence: [
            "The owned UIA helper timed out; Fusion was not cancelled and no action replay is attempted.",
          ],
        });
        return;
      }
      if (oversized) {
        resolve({
          status: "blocked",
          unavailableEvidence: ["UIA response exceeded its bounded size."],
        });
        return;
      }
      try {
        const result = parseMarked(
          stdout,
          mode === "watch-status"
            ? "FMCAD_UI_WATCHER_STATUS "
            : "FMCAD_UI_RESULT ",
        );
        if (code !== 0 && result.status === "ready") result.status = "blocked";
        if (stderr.trim())
          result.helperDiagnostic = redactDiagnostic(stderr.trim());
        resolve(result);
      } catch (caught) {
        const error = caught as Error;
        resolve({
          status: code === 0 ? "unavailable" : "blocked",
          unavailableEvidence: [
            redactDiagnostic(error.message),
            ...(stderr.trim() ? [redactDiagnostic(stderr.trim())] : []),
          ],
        });
      }
    });
  });
  return {
    child,
    completion,
    ready,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      return completion;
    },
  };
}

export function hostUiCall(
  mode: string,
  request: UiHostRequest,
  dependencies: UiHostDependencies = {},
) {
  return startHostHelper(mode, request, dependencies).completion;
}
