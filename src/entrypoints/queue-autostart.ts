import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";
import type { FmcadConfiguration } from "../api";

const runtimeRequire = createRequire(__filename);

type QueueRecord = Record<string, unknown>;

type StartupConfiguration = FmcadConfiguration & {
  queue: FmcadConfiguration["queue"] & { readonly exclusiveStart?: boolean };
};

interface QueueAuth {
  readonly clientId: string;
  readonly clientToken: string;
}

interface ResetOptions {
  readonly fusionResetNonce?: string;
}

interface QueueRuntime {
  request(
    directory: string,
    message: QueueRecord,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  queueDirectory(): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
  processBirth(pid?: number): string;
  reclaim(directory: string): unknown;
  fail(code: string, message: string): never;
}

interface RuntimePathAdapter {
  resolveRuntimePaths(options: { anchor: string }): unknown;
  resolveChildEntrypoint(
    paths: unknown,
    name: "queue-autostart-worker",
  ): string;
}

const queue = {
  ...(runtimeRequire("../../queue-connection.js") as Pick<
    QueueRuntime,
    "request" | "queueDirectory"
  >),
  ...(runtimeRequire("../../queue-instance.js") as Pick<
    QueueRuntime,
    "durable" | "readJson" | "processBirth" | "reclaim" | "fail"
  >),
};
const platform = runtimeRequire(
  "../../dist/config-platform",
) as RuntimePathAdapter;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export const missing = (error: unknown): boolean =>
  ["ENOENT", "ECONNREFUSED"].includes(errorCode(error) ?? "");
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function readRecord(file: string): QueueRecord | null {
  try {
    return queue.readJson(file) as QueueRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

function startupOwner(dir: string, claim: QueueRecord): QueueRecord {
  const child = readRecord(
    path.join(dir, "autostart", String(claim["nonce"]) + ".process.json"),
  );
  return child !== null &&
    child["nonce"] === claim["nonce"] &&
    Number.isSafeInteger(child["pid"]) &&
    typeof child["birth"] === "string"
    ? child
    : claim;
}

function claimStart(file: string, value: QueueRecord): void {
  const temp = file + "." + String(value["nonce"]) + ".tmp";
  queue.durable(temp, value, true);
  try {
    fs.linkSync(temp, file); // Atomic, fully written publication; never replaces a claimant.
    const fd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.unlinkSync(temp);
  }
}

function recoverableBroker(dir: string, owner: QueueRecord): boolean {
  const nonce = owner["nonce"];
  if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/.test(nonce)) return false;
  const file = path.join(dir, `broker-lifecycle-${nonce}.json`);
  const lifecycle = readRecord(file);
  // Protocol 2 durably creates lifecycle before any startup SDK probe. A death
  // before that file exists can restore the supervisor without issuing work.
  if (!lifecycle && owner["protocol"] === 2 && !fs.existsSync(file))
    return true;
  if (
    !lifecycle ||
    !isRecord(lifecycle["owner"]) ||
    lifecycle["owner"]["pid"] !== owner["pid"] ||
    lifecycle["owner"]["birth"] !== owner["birth"] ||
    lifecycle["owner"]["nonce"] !== nonce
  )
    return false;
  if (
    ["ready", "recovery"].includes(String(lifecycle["stage"])) ||
    (lifecycle["stage"] === "rejected" && lifecycle["safeToRecover"] === true)
  )
    return true;
  if (lifecycle["stage"] !== "starting") return false;
  const expected = path.join(dir, `broker-startup-${nonce}.receipt.json`);
  if (lifecycle["receipt"] !== expected) return false;
  const receipt = readRecord(expected);
  const binding = lifecycle["binding"];
  if (
    !receipt ||
    !isRecord(binding) ||
    receipt["terminal"] !== true ||
    !["succeeded", "failed"].includes(String(receipt["outcome"]))
  )
    return false;
  return (
    ["brokerNonce", "ownerPid", "ownerBirth", "buildHash", "stage"].every(
      (key) => receipt[key] === binding[key],
    ) &&
    binding["brokerNonce"] === nonce &&
    binding["ownerPid"] === owner["pid"] &&
    binding["ownerBirth"] === owner["birth"]
  );
}

function isRecord(value: unknown): value is QueueRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const recoveryRace = (error: unknown): boolean =>
  [
    "EEXIST",
    "ENOENT",
    "BROKER_ALIVE",
    "STARTER_ALIVE",
    "LOCK_CHANGED",
    "RECOVERY_IN_PROGRESS",
    "BROKER_MARKER_PRESENT",
  ].includes(errorCode(error) ?? "");

export function releaseStart(dir: string, nonce: string): void {
  const file = path.join(dir, "autostart.lock");
  if (
    fs.existsSync(file) &&
    (queue.readJson(file) as QueueRecord)["nonce"] === nonce
  )
    fs.unlinkSync(file);
}

export function startupResult(
  dir: string,
  nonce: string,
  result: QueueRecord,
): void {
  queue.durable(path.join(dir, "autostart", nonce + ".json"), {
    nonce,
    ...result,
  });
}

function launch(
  dir: string,
  cfg: StartupConfiguration,
  nonce: string,
  fusionResetNonce: string | undefined,
): void {
  const stdout = fs.openSync(
    path.join(dir, "autostart", nonce + ".stdout.log"),
    "wx",
    0o600,
  );
  let stderr: number;
  try {
    stderr = fs.openSync(
      path.join(dir, "autostart", nonce + ".stderr.log"),
      "wx",
      0o600,
    );
  } catch (error) {
    fs.closeSync(stdout);
    throw error;
  }
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "FMCAD_CONFIG",
      "FMCAD_PYTHON",
      "WSL_DISTRO_NAME",
      "TMPDIR",
      "SYSTEMROOT",
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    if (fusionResetNonce) env["FMCAD_FUSION_RESET_NONCE"] = fusionResetNonce;
    const paths = platform.resolveRuntimePaths({ anchor: __filename });
    const child = spawn(
      process.execPath,
      [platform.resolveChildEntrypoint(paths, "queue-autostart-worker"), nonce],
      {
        cwd: dir,
        env,
        detached: true,
        shell: false,
        stdio: ["pipe", stdout, stderr],
      },
    );
    child.once("error", (error: Error) => {
      startupResult(dir, nonce, {
        state: "failed",
        code: "BROKER_SPAWN_FAILED",
        message: error.message,
      });
      releaseStart(dir, nonce);
    });
    // Configuration/credentials travel over an owned pipe, never argv or a log.
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(cfg));
    child.unref();
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

export function assertResetAccess(dir: string, allowNonce?: string): void {
  let marker: QueueRecord;
  try {
    marker = queue.readJson(path.join(dir, "fusion-reset.lock")) as QueueRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (
    !allowNonce ||
    marker["nonce"] !== allowNonce ||
    marker["pid"] !== process.pid ||
    marker["birth"] !== queue.processBirth()
  ) {
    queue.fail(
      "FUSION_RESET_IN_PROGRESS",
      "A guarded Fusion reset owns the broker directory; no replacement was started.",
    );
  }
}

export async function ensureBroker(
  cfg: StartupConfiguration,
  auth: QueueAuth,
  { fusionResetNonce }: ResetOptions = {},
): Promise<unknown> {
  if (cfg.routing !== "queue" || cfg.queue?.autoStart === false) {
    queue.fail(
      "QUEUE_NOT_RUNNING",
      "Queue broker is not running; automatic startup is disabled. Start fmcad queue serve separately. No direct fallback.",
    );
  }
  const dir = queue.queueDirectory();
  const timeout = cfg.queue?.startupTimeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 600000)
    queue.fail(
      "INVALID_STARTUP_TIMEOUT",
      "queue.startupTimeoutMs must be 1..600000 ms",
    );
  const started = performance.now();
  let launched = false;
  let observedNonce: string | undefined;
  const exclusive = cfg.queue?.exclusiveStart === true;
  fs.mkdirSync(path.join(dir, "autostart"), {
    recursive: true,
    mode: 0o700,
  });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    queue.fail("UNSAFE_DIRECTORY", "Unsafe broker state directory");
  for (;;) {
    assertResetAccess(dir, fusionResetNonce);
    if (exclusive) {
      if (!launched) {
        for (const name of ["broker.lock", "autostart.lock", "recovery.lock"]) {
          try {
            fs.lstatSync(path.join(dir, name));
          } catch (error) {
            if (errorCode(error) === "ENOENT") continue;
            throw error;
          }
          queue.fail(
            "OWNERSHIP_CONFLICT",
            "Explicit startup found an ownership marker; no recovery was attempted",
          );
        }
      } else {
        const broker = readRecord(path.join(dir, "broker.lock"));
        const child = readRecord(
          path.join(dir, "autostart", observedNonce + ".process.json"),
        );
        if (
          broker &&
          (!child ||
            child["nonce"] !== observedNonce ||
            broker["pid"] !== child["pid"] ||
            broker["birth"] !== child["birth"])
        )
          queue.fail(
            "OWNERSHIP_CONFLICT",
            "A different process won explicit startup; it was not reused or reclaimed",
          );
      }
    }
    try {
      const registered = await queue.request(
        dir,
        { action: "register", ...auth },
        {
          timeoutMs: Math.max(
            1,
            Math.min(3000, timeout - (performance.now() - started)),
          ),
        },
      );
      if (exclusive && !launched)
        queue.fail(
          "OWNERSHIP_CONFLICT",
          "An existing broker answered explicit startup; it was not restarted",
        );
      if (exclusive) {
        const broker = readRecord(path.join(dir, "broker.lock"));
        const child = readRecord(
          path.join(dir, "autostart", observedNonce + ".process.json"),
        );
        if (
          !broker ||
          !child ||
          child["nonce"] !== observedNonce ||
          broker["pid"] !== child["pid"] ||
          broker["birth"] !== child["birth"] ||
          queue.processBirth(broker["pid"] as number) !== broker["birth"]
        )
          queue.fail(
            "OWNERSHIP_CONFLICT",
            "Explicit startup response has no matching live child identity",
          );
      }
      return registered;
    } catch (error) {
      if (!missing(error)) throw error;
    }

    const marker = path.join(dir, "broker.lock");
    const startup = path.join(dir, "autostart.lock");
    if (observedNonce) {
      const result = readRecord(
        path.join(dir, "autostart", observedNonce + ".json"),
      );
      if (result?.["state"] === "failed" && result["code"] !== "EEXIST")
        queue.fail(
          typeof result["code"] === "string"
            ? result["code"]
            : "BROKER_START_FAILED",
          typeof result["message"] === "string"
            ? result["message"]
            : "Broker startup failed; inspect private startup logs",
        );
    }
    const brokerOwner = readRecord(marker);
    if (brokerOwner) {
      const owner = brokerOwner;
      let alive: boolean;
      try {
        alive = queue.processBirth(owner["pid"] as number) === owner["birth"];
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) alive = false;
        else throw error;
      }
      if (!alive) {
        if (exclusive)
          queue.fail(
            "BROKER_STALE",
            "Explicit startup does not reclaim stale ownership",
          );
        if (cfg.queue?.autoRecover === false)
          queue.fail(
            "BROKER_STALE",
            "Previous broker marker remains and queue.autoRecover is false; explicit recovery required.",
          );
        if (recoverableBroker(dir, owner)) {
          try {
            // Recover only the dead supervisor. The original job/lease owner and
            // any unknown outcome remain durable and block normal dispatch.
            queue.reclaim(dir);
            launched = false;
            observedNonce = undefined;
            continue;
          } catch (error) {
            if (!recoveryRace(error)) throw error;
          }
        } else if (
          !fs.existsSync(
            path.join(dir, `broker-lifecycle-${String(owner["nonce"])}.json`),
          )
        ) {
          queue.fail(
            "BROKER_STALE",
            "Legacy broker marker has no bound lifecycle proof; one-time explicit reconciliation is required.",
          );
        }
      }
    } else if (!fs.existsSync(marker) && !fs.existsSync(startup) && !launched) {
      const nonce = randomUUID();
      try {
        claimStart(startup, {
          nonce,
          pid: process.pid,
          birth: queue.processBirth(),
        });
        launched = true;
        observedNonce = nonce;
        try {
          launch(dir, cfg, nonce, fusionResetNonce);
        } catch (error) {
          releaseStart(dir, nonce);
          throw error;
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (exclusive)
          queue.fail(
            "OWNERSHIP_CONFLICT",
            "Another claimant won explicit startup",
          );
      }
    }
    const startupClaim = readRecord(startup);
    if (startupClaim) {
      const owner = startupClaim;
      const processOwner = startupOwner(dir, owner);
      observedNonce = owner["nonce"] as string | undefined;
      const resultFile = path.join(dir, "autostart", owner["nonce"] + ".json");
      if (fs.existsSync(resultFile)) {
        const result = queue.readJson(resultFile) as QueueRecord;
        if (result["state"] === "failed" && result["code"] !== "EEXIST")
          queue.fail(
            typeof result["code"] === "string"
              ? result["code"]
              : "BROKER_START_FAILED",
            typeof result["message"] === "string"
              ? result["message"]
              : "Broker startup failed; inspect private startup logs",
          );
      }
      let alive: boolean;
      try {
        alive =
          queue.processBirth(processOwner["pid"] as number) ===
          processOwner["birth"];
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) alive = false;
        else throw error;
      }
      if (!alive && !fs.existsSync(marker)) {
        if (cfg.queue?.autoRecover === false)
          queue.fail(
            "STARTUP_STALE",
            "Interrupted startup claim remains and queue.autoRecover is false",
          );
        try {
          reclaimStart(dir);
          launched = false;
          observedNonce = undefined;
          continue;
        } catch (error) {
          if (!recoveryRace(error)) throw error;
        }
      }
    }
    if (performance.now() - started >= timeout)
      queue.fail(
        "BROKER_START_TIMEOUT",
        "Timed out waiting for broker startup; no command was submitted. The broker may still start; inspect status before retrying.",
      );
    await sleep(100);
  }
}

export function reclaimStart(dir = queue.queueDirectory()): QueueRecord {
  if (fs.existsSync(path.join(dir, "broker.lock")))
    queue.fail(
      "BROKER_MARKER_PRESENT",
      "Reclaim/reconcile the broker marker first",
    );
  const file = path.join(dir, "autostart.lock");
  const owner = queue.readJson(file) as QueueRecord;
  const processOwner = startupOwner(dir, owner);
  let alive: boolean;
  try {
    alive =
      queue.processBirth(processOwner["pid"] as number) ===
      processOwner["birth"];
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) alive = false;
    else throw error;
  }
  if (alive) queue.fail("STARTER_ALIVE", "The startup claimant is still alive");
  // Serialize reclaim; never remove a claim that has changed since inspection.
  const claim = path.join(dir, "recovery.lock");
  queue.durable(claim, { pid: process.pid, birth: queue.processBirth() }, true);
  try {
    if (
      JSON.stringify(queue.readJson(file)) !== JSON.stringify(owner) ||
      fs.existsSync(path.join(dir, "broker.lock"))
    )
      queue.fail("LOCK_CHANGED", "Startup ownership changed during recovery");
    const latest = startupOwner(dir, owner);
    try {
      if (queue.processBirth(latest["pid"] as number) === latest["birth"])
        queue.fail("STARTER_ALIVE", "The startup daemon is still alive");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) throw error;
    }
    queue.durable(
      path.join(dir, "autostart", owner["nonce"] + ".reclaimed.json"),
      owner,
      true,
    );
    fs.unlinkSync(file);
    return {
      reclaimedStartup: true,
      previousPid: processOwner["pid"],
      noFusionRequestSent: true,
    };
  } finally {
    fs.unlinkSync(claim);
  }
}
