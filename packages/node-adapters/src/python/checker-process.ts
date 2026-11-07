import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { PythonCheckAbortSignal } from "../../../core/src/domain/python-checker.js";

export interface CheckerProcessLimits {
  readonly timeoutMs: number;
  readonly outputBytes: number;
  readonly memoryBytes: number;
}
export interface CheckerProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly problem: string | null;
}

/** No shell, stdin code execution, inherited Python paths or package installers. */
export function runCheckerProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  limits: CheckerProcessLimits,
  input = "",
  signal?: PythonCheckAbortSignal,
): Promise<CheckerProcessResult> {
  if (signal?.aborted)
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "",
      problem: "aborted",
    });
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: cwd,
        TMPDIR: cwd,
        LANG: "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let problem: string | null = null;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    const stop = (reason: string): void => {
      problem ??= reason;
      child.kill("SIGKILL");
    };
    const abort = (): void => stop("aborted");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (target: Buffer[], data: Buffer): void => {
      bytes += data.length;
      if (bytes > limits.outputBytes) stop("output limit exceeded");
      else target.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(out, data));
    child.stderr.on("data", (data: Buffer) => collect(err, data));
    child.on("error", (error) => {
      problem ??= error.message;
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    const deadline = setTimeout(() => stop("timeout"), limits.timeoutMs);
    // Linux/WSL2 are the supported local platforms. This is sampled RSS,
    // supplemented by the engine's V8 heap cap, not a sandbox/cgroup guarantee.
    const memory = setInterval(() => {
      if (!child.pid) return;
      void readFile(`/proc/${child.pid}/status`, "utf8")
        .then((status) => {
          const rss = /VmRSS:\s+(\d+) kB/.exec(status);
          if (rss?.[1] && Number(rss[1]) * 1024 > limits.memoryBytes)
            stop("memory limit exceeded");
        })
        .catch(() => undefined);
    }, 25);
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearInterval(memory);
      signal?.removeEventListener("abort", abort);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        problem,
      });
    });
  });
}
