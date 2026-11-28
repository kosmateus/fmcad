#!/usr/bin/env node
import type {
  EpochUpgradePorts,
  EpochStages,
} from "../packages/core/dist/application/cad/epoch-upgrade";
import type {
  OperatorPointer,
  OperatorIntent,
  OperatorProcess,
} from "../packages/node-adapters/dist/execution/epoch-operator-evidence";
import type { FmcadConfiguration as Config } from "../packages/core/dist/domain/config";
import { createRequire } from "node:module";
const load = createRequire(__filename);
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
const local = fs.existsSync(
  path.join(__dirname, "../src/queue-epoch-runtime-upgrade.js"),
)
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "../dist");
const upgrade = load(local + "/src/queue-epoch-runtime-upgrade") as ReturnType<
  typeof import("../packages/core/dist/application/cad/epoch-upgrade").epochUpgradePolicy
>;
const { createEpochRuntimeUpgrade, createSettledEpochRuntimeUpgrade } = upgrade;
const schema = load(
  local + "/src/dist/node-adapters/execution/epoch-operator-evidence",
) as typeof import("../packages/node-adapters/dist/execution/epoch-operator-evidence");
interface Client {
  dir: string;
  auth: { clientId: string; clientToken: string };
  call(action: string, input?: unknown): Promise<unknown>;
  dispose(): void;
}
interface Instance {
  readJson(file: string, limit?: number): unknown;
  hash(value: string): string;
  buildHash(root: string): string;
  priorProcessAlive(value: unknown): boolean | null;
  processBirth(): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  brokerConfigHash(config: Config): string;
}
type ScriptStages = EpochStages & {
  intent: OperatorIntent;
  "install-intent": {
    previous: string;
    staged: string;
    installed: string;
    buildHash: string;
    previousBuildHash: string;
  };
  worker: OperatorProcess;
  "worker-ready": { buildHash: string; owner: unknown };
  "worker-launch": Record<string, unknown>;
  "worker-error": Record<string, unknown>;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const opts: Record<string, string> = {},
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !value ||
      ![
        "--approval",
        "--confirm-ownership",
        "--preflight",
        "--config",
      ].includes(key) ||
      opts[key]
    )
      fail(
        "INVALID_REQUEST",
        "Exact approval/ownership or preflight required; no client override",
      );
    opts[key] = value;
  }
  if (
    !path.isAbsolute(opts["--approval"] || "") ||
    (opts["--preflight"] !== "true" && opts["--confirm-ownership"] !== "true")
  )
    fail(
      "INVALID_REQUEST",
      "Absolute approval and --confirm-ownership true (or read-only --preflight true) required",
    );
  const approvalFile = opts["--approval"] ?? "";
  if (!approvalFile) fail("INVALID_REQUEST", "Absolute approval required");
  const approval = schema.operatorApproval(
    JSON.parse(fs.readFileSync(approvalFile, "utf8")) as unknown,
  );
  const settled =
    approval.purpose === "quiescent-settled-isolated-epoch-upgrade-v1";
  const launchRoot = settled ? approval.candidateRoot : approval.installRoot;
  const controlRequestId =
    approval.requestId + (settled ? ":pause-stop" : ":pause");
  const root = approval.candidateRoot;
  if (
    root !== local ||
    !path.isAbsolute(approval.installRoot || "") ||
    root === approval.installRoot ||
    !/^[a-f0-9]{40}$/.test(approval.sourceCommit || "") ||
    !/^[a-f0-9]{64}$/.test(approval.buildHash || "") ||
    !/^[a-f0-9]{64}$/.test(approval.previousBuildHash || "") ||
    approval.buildHash === approval.previousBuildHash ||
    typeof approval.requestId !== "string" ||
    !approval.requestId.trim() ||
    approval.requestId.length > 180 ||
    typeof approval.clientId !== "string" ||
    typeof approval.granteeClientId !== "string" ||
    !approval.granteeClientId.trim() ||
    !Array.isArray(approval.ledgerReferences) ||
    approval.ledgerReferences.length < 2
  )
    fail(
      "INVALID_REQUEST",
      "Run the exact qualified installed adapter with explicit source/build, distinct roots and original-ledger references",
    );
  if (
    !approval.stateOptions ||
    Object.keys(approval.stateOptions).sort().join(",") !== "idleMs,leaseMs" ||
    approval.stateOptions.idleMs !== (settled ? 60000 : 180000) ||
    approval.stateOptions.leaseMs !== (settled ? 600000 : 1800000)
  )
    fail(
      "INVALID_REQUEST",
      "Explicit bounded queue budgets required: settled handoff preserves standard 60s idle/10min lease; legacy smoke repair uses 180s/30min",
    );
  const api = load(root + "/src/queue-instance") as Instance,
    files = load(
      root + "/src/queue-atomic-migration-files",
    ) as typeof import("../packages/node-adapters/dist/persistence/migration-files");
  const { cfg } = (
    load(root + "/src/config") as {
      loadConfig(input: { config?: string }): { cfg: Config };
    }
  ).loadConfig(opts["--config"] ? { config: opts["--config"] } : {});
  const client = new (
    load(root + "/src/queue-client") as {
      QueueClient: new (
        id: string | undefined,
        options: { cfg: Config; existingCredentialsOnly: true },
      ) => Client;
    }
  ).QueueClient(process.env["FMCAD_CLIENT"] || cfg.queue?.client, {
    cfg,
    existingCredentialsOnly: true,
  });
  const dir = client.dir,
    audit = path.join(
      dir,
      "epoch-runtime-upgrades",
      api.hash(approval.requestId || ""),
    );
  const decode = {
    initial: schema.operatorSnapshot,
    paused: schema.operatorSnapshot,
    complete: schema.operatorObject,
    identity: (value: unknown) => schema.operatorStage("identity", value),
    escrow: (value: unknown) => value,
    stopped: (value: unknown) => value,
    "stop-intent": (value: unknown) => value,
    installed: (value: unknown) => value,
    "launch-intent": (value: unknown) => value,
    intent: schema.operatorIntent,
    "install-intent": (value: unknown) => {
      const row = schema.operatorObject(value);
      return {
        previous: schema.operatorText(row["previous"]),
        staged: schema.operatorText(row["staged"]),
        installed: schema.operatorText(row["installed"]),
        buildHash: schema.operatorText(row["buildHash"]),
        previousBuildHash: schema.operatorText(row["previousBuildHash"]),
      };
    },
    worker: schema.operatorProcess,
    "worker-ready": (value: unknown) => {
      const row = schema.operatorObject(value);
      return {
        buildHash: schema.operatorText(row["buildHash"]),
        owner: row["owner"],
      };
    },
    "worker-launch": schema.operatorObject,
    "worker-error": schema.operatorObject,
  } satisfies {
    [K in keyof ScriptStages]: (value: unknown) => ScriptStages[K];
  };
  function read<K extends keyof ScriptStages>(
    stage: K,
  ): ScriptStages[K] | undefined {
    const f = path.join(audit, stage + ".json");
    if (!fs.existsSync(f)) return undefined;
    const decoder: {
      [K in keyof ScriptStages]: (value: unknown) => ScriptStages[K];
    } = decode;
    return decoder[stage](api.readJson(f, 256 * 1024 * 1024));
  }
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const digest = (value: unknown) => api.hash(JSON.stringify(value));
  const approvalHash = files.fileHash(approvalFile).sha256;
  let intent: OperatorIntent;
  let claim: OperatorProcess | undefined;
  const marker = () => ({
    kind: "isolated-epoch-runtime-upgrade",
    nonce: intent.nonce,
    audit,
    clientId: approval.clientId,
  });
  function processFence() {
    if (api.priorProcessAlive(approval.currentInstance) !== true)
      fail("INSTANCE_CHANGED", "Selected qualified Fusion is no longer live");
  }
  function evidence(pointer: OperatorPointer) {
    return pointer.qualificationEvidence
      .concat([pointer.qualificationReceipt], approval.ledgerReferences || [])
      .map((entry) => {
        if (files.fileHash(entry.path).sha256 !== entry.sha256)
          fail(
            "EVIDENCE_CHANGED",
            "Original scratch or failed ledger evidence changed",
          );
        return entry;
      });
  }
  function localSnapshot() {
    const pointerFile = path.join(dir, "isolated-admission-epoch.json"),
      pointer = schema.operatorPointer(api.readJson(pointerFile));
    if (
      pointer.root !== path.join(dir, "admission-epochs", pointer.epochId) ||
      fs.realpathSync(pointer.root) !== pointer.root
    )
      fail("EPOCH_UPGRADE_FENCE_CHANGED", "Canonical current epoch required");
    const state = schema.operatorState(
      api.readJson(
        path.join(pointer.root, "queue-state.json"),
        256 * 1024 * 1024,
      ),
    );
    const clients = schema.operatorClients(
      api.readJson(path.join(dir, "clients.json")),
    );
    const grants = fs
      .readdirSync(pointer.root)
      .filter((name) => /^access-[a-f0-9]{64}\.json$/.test(name))
      .sort()
      .map((name) => ({
        name,
        ...files.fileHash(path.join(pointer.root, name)),
      }));
    const granteeHash = clients[approval.granteeClientId];
    if (!granteeHash)
      fail(
        "GRANT_CHANGED",
        "Exact already registered modeling client required",
      );
    const grantFile = path.join(
      pointer.root,
      "access-" +
        api.hash(approval.granteeClientId + "\0" + granteeHash) +
        ".json",
    );
    const grant = schema.operatorGrant(api.readJson(grantFile));
    if (
      grant.clientId !== approval.granteeClientId ||
      grant.clientTokenHash !== granteeHash ||
      grant.epochId !== pointer.epochId ||
      !equal(grant.document, pointer.document)
    )
      fail(
        "GRANT_CHANGED",
        "Native client must retain the exact existing credential-bound document grant",
      );
    const settledEvidence = settled
      ? schema.operatorReferences(
          (
            load(root + "/src/queue-settled-epoch-evidence") as {
              settledEpochEvidence(
                root: string,
                state: unknown,
                pointer: unknown,
              ): unknown;
            }
          ).settledEpochEvidence(dir, state, pointer),
        )
      : undefined;
    for (const job of settled ? [] : Object.values(state.jobs)) {
      const jobDir = path.join(dir, "jobs", job.id),
        outcome = schema.operatorObject(
          api.readJson(path.join(jobDir, 'outcome["json"]')),
        );
      if (
        outcome["executionOutcome"] !== "not_started" ||
        outcome["userScriptSubmitted"] !== false ||
        outcome["mayHaveMutated"] !== false ||
        outcome["sdkSettled"] !== true ||
        fs
          .readdirSync(jobDir)
          .some((name) =>
            /^(rpc-|remote-|preflight-|postflight-)/.test(name),
          ) ||
        api.priorProcessAlive(
          api.readJson(path.join(jobDir, "worker-identity.json")),
        ) !== false
      )
        fail(
          "EPOCH_UPGRADE_REQUIRES_SDK0",
          "Every existing epoch job must have independently settled local-only rejection",
        );
    }
    return {
      pointer,
      state,
      ...(settled ? { settledEvidence } : {}),
      identity: schema.operatorIdentity(
        api.readJson(path.join(pointer.root, "instance.json")),
      ),
      pointerHash: files.fileHash(pointerFile).sha256,
      rootStateHash: files.fileHash(path.join(dir, "queue-state.json")).sha256,
      rootIdentityHash: files.fileHash(path.join(dir, "instance.json")).sha256,
      grantsHash: digest(grants),
      evidenceHash: digest(evidence(pointer).concat(settledEvidence || [])),
      ownerTokenHash: clients[approval.clientId] ?? "",
      selectedLive: api.priorProcessAlive(pointer.currentInstance) === true,
      historicalDead: api.priorProcessAlive(pointer.originalInstance) === false,
      closed: fs.existsSync(path.join(pointer.root, "closed.json")),
      cleanupIntent: fs.existsSync(
        path.join(
          settled
            ? (
                load(root + "/src/queue-epoch-lineage") as {
                  epochControlDirectory(root: string, pointer: unknown): string;
                }
              ).epochControlDirectory(dir, pointer)
            : dir,
          "isolated-scratch-close",
          "intent.json",
        ),
      ),
      pending:
        fs.existsSync(path.join(pointer.root, "queue-state.pending.json")) ||
        fs.existsSync(path.join(dir, "queue-state.pending.json")),
    };
  }
  async function observe() {
    const status = schema.operatorObject(await client.call("queue-summary")),
      snapshot = localSnapshot(),
      owner = schema.operatorOwner(api.readJson(path.join(dir, "broker.lock")));
    if (!read("installed")) {
      const argv = fs
        .readFileSync("/proc/" + owner.pid + "/cmdline")
        .toString()
        .split("\0");
      if (
        !(
          settled
            ? [
                "queue-epoch-successor-worker.js",
                "queue-epoch-runtime-worker.js",
              ]
            : [
                "queue-atomic-migration-worker.js",
                "queue-epoch-runtime-worker.js",
              ]
        ).some((file) =>
          argv.includes(path.join(approval.installRoot, "src", file)),
        )
      )
        fail(
          "OWNER_COMMAND_CHANGED",
          "Current broker does not execute from the approved installed runtime root",
        );
    }
    return schema.operatorSnapshot({
      ...snapshot,
      owner,
      control: status["control"],
      brokerLive: api.priorProcessAlive(owner),
      status,
    });
  }
  async function approve() {
    if (
      files.fileHash(approvalFile).sha256 !== approvalHash ||
      api.buildHash(root) !== approval.buildHash ||
      fs.realpathSync(root) !== root ||
      files.fileHash(__filename).sha256 !== approval.adapterSha256 ||
      api.brokerConfigHash(cfg) !==
        schema.operatorObject(api.readJson(path.join(dir, "instance.json")))[
          "configHash"
        ]
    )
      fail(
        "BUILD_CHANGED",
        "Approved candidate bytes, approval or backend configuration changed",
      );
    const q = approval.qualification;
    if (!q || files.fileHash(q.path).sha256 !== q.sha256)
      fail(
        "QUALIFICATION_REQUIRED",
        "Immutable installed qualification required",
      );
    const qualified = schema.operatorObject(
      api.readJson(q.path, 256 * 1024 * 1024),
    );
    if (
      qualified["sourceCommit"] !== approval.sourceCommit ||
      qualified["buildHash"] !== approval.buildHash ||
      qualified["passed"] !== true ||
      qualified["epochRuntimeUpgradeQualified"] !== true ||
      qualified["productionAdmission"] !== true ||
      (settled && qualified["settledEpochRuntimeUpgradeQualified"] !== true)
    )
      fail(
        "QUALIFICATION_REQUIRED",
        "Candidate lacks actual installed checker and current-epoch upgrade qualification",
      );
    const oldClients = schema.operatorClients(
      api.readJson(path.join(dir, "clients.json")),
    );
    if (oldClients[approval.clientId] !== api.hash(client.auth.clientToken))
      fail("NOT_OWNER", "Original credential was revoked");
    if (!read("installed")) {
      const prior = read("intent"),
        installing = read("install-intent");
      const previous =
        prior && approval.installRoot + ".epoch-before-" + prior.nonce;
      const midSwap =
        prior &&
        previous &&
        equal(prior.approval, approval) &&
        installing?.previous === previous &&
        fs.existsSync(previous) &&
        api.buildHash(previous) === approval.previousBuildHash;
      if (
        !midSwap &&
        api.buildHash(approval.installRoot) !== approval.previousBuildHash
      )
        fail(
          "BUILD_CHANGED",
          "Actual departing installed runtime differs from the approved previous build",
        );
    }
    processFence();
    return approval;
  }
  async function authenticate() {
    const clients = schema.operatorClients(
      api.readJson(path.join(dir, "clients.json")),
    );
    if (
      client.auth.clientId !== approval.clientId ||
      clients[approval.clientId] !== api.hash(client.auth.clientToken)
    )
      fail("NOT_OWNER", "Existing original epoch owner credentials required");
    for (const name of ["fusion-reset.lock", "autostart.lock"])
      if (fs.existsSync(path.join(dir, name)))
        fail("LIFECYCLE_BUSY", "Another lifecycle is active");
    for (const name of ["recovery.lock", "atomic-migration.lock"]) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) {
        const prior = read("intent");
        if (
          !prior ||
          !equal(api.readJson(f), {
            kind: "isolated-epoch-runtime-upgrade",
            nonce: prior.nonce,
            audit,
            clientId: approval.clientId,
          })
        )
          fail("LIFECYCLE_BUSY", "Another guarded transaction owns the queue");
      }
    }
  }
  if (opts["--preflight"] === "true") {
    try {
      await authenticate();
      await approve();
      const validator = upgrade;
      (settled
        ? validator.assertSettledEpochUpgrade
        : validator.assertEpochUpgrade)(await observe(), approval);
      console.log(
        JSON.stringify(
          {
            readyToPause: true,
            readyToStop: false,
            epochId: approval.epochId,
            historicalOutcome: "unknown",
            sdkRequestsSent: 0,
          },
          null,
          2,
        ),
      );
    } finally {
      client.dispose();
    }
    return;
  }
  const ports: EpochUpgradePorts = {
    authenticate,
    approve,
    read,
    observe,
    async claim() {
      const parent = path.dirname(audit);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      files.directory(parent);
      if (fs.realpathSync(parent) !== parent)
        fail(
          "UNSAFE_PATH",
          "Upgrade journal parent must not traverse a symlink",
        );
      fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
      files.directory(audit);
      if (fs.realpathSync(audit) !== audit)
        fail("UNSAFE_PATH", "Canonical upgrade audit required");
      const prior = read("intent");
      intent = prior || {
        version: 1,
        nonce: randomUUID(),
        approval,
        ownerTokenHash: api.hash(client.auth.clientToken),
      };
      if (
        intent.version !== 1 ||
        !/^[a-f0-9-]{36}$/.test(intent.nonce || "") ||
        !equal(intent.approval, approval) ||
        intent.ownerTokenHash !== api.hash(client.auth.clientToken)
      )
        fail("NOT_OWNER", "Existing intent differs");
      files.exclusive(path.join(audit, "intent.json"), intent);
      const f = path.join(audit, "adapter-worker.json");
      if (fs.existsSync(f)) {
        const old = schema.operatorProcess(api.readJson(f));
        if (api.priorProcessAlive(old) !== false)
          fail("UPGRADE_BUSY", "Existing adapter is live or unobservable");
        const archive = f + "." + digest(old).slice(0, 24) + ".retired";
        api.durable(archive + ".claim", old, true);
        if (!equal(api.readJson(f), old))
          fail("UPGRADE_BUSY", "Worker claim changed");
        fs.renameSync(f, archive);
      }
      claim = {
        pid: process.pid,
        birth: api.processBirth(),
        nonce: intent.nonce,
      };
      api.durable(f, claim, true);
    },
    unclaim() {
      if (!claim) return;
      const f = path.join(audit, "adapter-worker.json");
      if (!equal(api.readJson(f), claim))
        fail("UPGRADE_BUSY", "Never release another adapter");
      fs.renameSync(f, f + "." + digest(claim).slice(0, 24) + ".finished");
    },
    publish: (stage, value) =>
      files.exclusive(path.join(audit, stage + ".json"), value),
    pause: async (snapshot) => {
      await (!settled &&
      snapshot.state.paused &&
      snapshot.control.gateClosed === true
        ? undefined
        : client.call("pause", {
            control: {
              requestId: controlRequestId,
              instanceId: snapshot.owner.nonce,
              expectedGeneration: snapshot.control.generation,
            },
          }));
    },
    async escrow(snapshot) {
      // Small current state/identity and hash references; NEVER recopy old job history.
      const escrow = {
        version: 1,
        state: snapshot.state,
        identity: snapshot.identity,
        pointer: snapshot.pointer,
        grantsHash: snapshot.grantsHash,
        evidence: evidence(schema.operatorPointer(snapshot.pointer)).concat(
          schema.operatorReferences(snapshot.settledEvidence || []),
        ),
        originalRootState: {
          path: path.join(dir, "queue-state.json"),
          sha256: snapshot.rootStateHash,
        },
        originalRootIdentity: {
          path: path.join(dir, "instance.json"),
          sha256: snapshot.rootIdentityHash,
        },
        previousQualifiedRuntime: approval.previousQualifiedRuntime,
      };
      files.exclusive(path.join(audit, "epoch-escrow.json"), escrow);
      return {
        path: path.join(audit, "epoch-escrow.json"),
        sha256: files.fileHash(path.join(audit, "epoch-escrow.json")).sha256,
      };
    },
    async verifyEscrow(value) {
      const ref = schema.operatorReference(value);
      if (files.fileHash(ref.path).sha256 !== ref.sha256)
        fail("ESCROW_CHANGED", "Current-epoch escrow changed");
      const e = schema.operatorEscrow(
        api.readJson(ref.path, 256 * 1024 * 1024),
      );
      for (const entry of [
        ...e.evidence,
        e.originalRootState,
        e.originalRootIdentity,
      ])
        if (files.fileHash(entry.path).sha256 !== entry.sha256)
          fail("ESCROW_CHANGED", "Preserved evidence changed");
      if (
        api.buildHash(e.previousQualifiedRuntime) !== approval.previousBuildHash
      )
        fail("ESCROW_CHANGED", "Immutable previous runtime witness changed");
    },
    async guardStartup() {
      files.exclusive(path.join(dir, "recovery.lock"), marker());
    },
    stop: async (snapshot) => {
      await client.call(settled ? "console-stop" : "stop", {
        control: {
          requestId: settled ? controlRequestId : approval.requestId + ":stop",
          instanceId: snapshot.owner.nonce,
          expectedGeneration: snapshot.control.generation,
        },
      });
    },
    async waitDead(owner) {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (
          api.priorProcessAlive(owner) === false &&
          !fs.existsSync(path.join(dir, "broker.lock"))
        ) {
          if (settled) {
            const file = path.join(
              dir,
              "console-release-" + api.hash(controlRequestId) + ".json",
            );
            if (!fs.existsSync(file)) {
              await sleep(100);
              continue;
            }
            const receipt = schema.operatorObject(api.readJson(file));
            if (
              receipt["terminal"] !== true ||
              receipt["outcome"] !== "released" ||
              receipt["requestId"] !== controlRequestId ||
              receipt["instanceId"] !== owner.nonce ||
              receipt["buildHash"] !== approval.previousBuildHash
            )
              fail(
                "COOPERATIVE_STOP_UNKNOWN",
                "Exact successful console release receipt required",
              );
            files.exclusive(path.join(audit, "cooperative-release.json"), {
              path: file,
              sha256: files.fileHash(file).sha256,
            });
          }
          return;
        }
        await sleep(100);
      }
      fail(
        "COOPERATIVE_STOP_UNKNOWN",
        "Original broker has not released itself; no signal/retry/install permitted",
      );
    },
    async localFence(paused) {
      await authenticate();
      processFence();
      if (
        api.priorProcessAlive(paused.owner) !== false ||
        fs.existsSync(path.join(dir, "broker.lock"))
      )
        fail(
          "BROKER_STILL_LIVE",
          "Only a cooperatively stopped and released exact broker may be replaced",
        );
      const current = localSnapshot();
      if (
        !equal(current.state, paused.state) ||
        !equal(current.pointer, paused.pointer) ||
        current.grantsHash !== paused.grantsHash ||
        current.evidenceHash !== paused.evidenceHash ||
        current.rootStateHash !== paused.rootStateHash ||
        current.rootIdentityHash !== paused.rootIdentityHash ||
        current.closed ||
        current.cleanupIntent ||
        current.pending
      )
        fail(
          "EPOCH_UPGRADE_HISTORY_CHANGED",
          "New work or changed evidence prevents upgrade",
        );
    },
    async install() {
      if (settled) {
        if (
          api.buildHash(root) !== approval.buildHash ||
          api.buildHash(approval.installRoot) !== approval.previousBuildHash
        )
          fail(
            "BUILD_CHANGED",
            "Both immutable installed releases must retain their approved bytes",
          );
        return {
          previous: approval.installRoot,
          installed: root,
          buildHash: approval.buildHash,
          immutableReleases: true,
        };
      }
      const staged = approval.installRoot + ".epoch-staged-" + intent.nonce;
      const previous = approval.installRoot + ".epoch-before-" + intent.nonce;
      files.exclusive(path.join(audit, "install-intent.json"), {
        previous,
        staged,
        installed: approval.installRoot,
        buildHash: approval.buildHash,
        previousBuildHash: approval.previousBuildHash,
      });
      if (!fs.existsSync(previous)) {
        files.backupTree(root, staged);
        if (
          api.buildHash(staged) !== approval.buildHash ||
          api.buildHash(approval.installRoot) !== approval.previousBuildHash
        )
          fail("BUILD_CHANGED", "Staged or departing runtime differs");
        fs.renameSync(approval.installRoot, previous);
      }
      if (api.buildHash(previous) !== approval.previousBuildHash)
        fail(
          "BUILD_CHANGED",
          "Preserved departing runtime differs from its immutable witness",
        );
      if (!fs.existsSync(approval.installRoot))
        fs.renameSync(staged, approval.installRoot);
      const fd = fs.openSync(path.dirname(approval.installRoot), "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        previous,
        installed: approval.installRoot,
        buildHash: approval.buildHash,
      };
    },
    async verifyInstalled() {
      if (
        api.buildHash(launchRoot) !== approval.buildHash ||
        (settled &&
          api.buildHash(approval.installRoot) !== approval.previousBuildHash) ||
        (
          load(root + "/src/queue-atomic-migration-runtime") as {
            checkerContentFingerprint(root: string): string;
          }
        ).checkerContentFingerprint(launchRoot) !==
          (
            load(root + "/src/queue-atomic-migration-runtime") as {
              checkerContentFingerprint(root: string): string;
            }
          ).checkerContentFingerprint(root)
      )
        fail("BUILD_CHANGED", "Installed checker/runtime differs");
    },
    async writeEpochIdentity(previous, next) {
      const paused = read("paused");
      if (!paused)
        fail("IDENTITY_CHANGED", "Original paused evidence required");
      const file = path.join(
        schema.operatorPointer(paused.pointer).root,
        "instance.json",
      );
      const current = api.readJson(file);
      if (equal(current, next)) return; // Publication-only crash resume.
      if (!equal(current, previous))
        fail("IDENTITY_CHANGED", "Never replace a foreign epoch identity");
      api.durable(file, next); // Explicit authenticated transaction, old bytes retained in immutable escrow.
    },
    async start() {
      files.exclusive(path.join(dir, "atomic-migration.lock"), marker());
      const worker = read("worker");
      if (worker) {
        if (api.priorProcessAlive(worker) === true) return;
        fail(
          "UPGRADE_START_UNKNOWN",
          "Existing worker is dead/unobservable; retain evidence, never relaunch blindly",
        );
      }
      if (read("worker-launch"))
        fail(
          "UPGRADE_START_UNKNOWN",
          "A launch was already intended without a worker receipt; inspect it, never launch again blindly",
        );
      files.exclusive(path.join(audit, "worker-launch.json"), {
        buildHash: approval.buildHash,
        nonce: intent.nonce,
      });
      // A child wins its exclusive worker receipt before claiming a broker.
      const f = path.join(audit, "worker.log");
      const fd = fs.openSync(f, "a", 0o600);
      const env: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "FMCAD_CONFIG",
        "FMCAD_PYTHON",
        "WSL_DISTRO_NAME",
        "TMPDIR",
        "SYSTEMROOT",
      ])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      const child = spawn(
        process.execPath,
        [path.join(launchRoot, "src/queue-epoch-runtime-worker.js"), audit],
        { detached: true, stdio: ["pipe", fd, fd], cwd: dir, env },
      );
      child.once("error", (error) => {
        try {
          files.exclusive(path.join(audit, "worker-error.json"), {
            code: ("code" in error ? error.code : undefined) || "SPAWN_FAILED",
            message: error.message,
          });
        } catch {
          /* Preserve unknown launch without replacing existing evidence. */
        }
      });
      if (!child.stdin)
        fail(
          "UPGRADE_START_UNKNOWN",
          "Launched worker has no input pipe; retain evidence without retry",
        );
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ cfg, nonce: intent.nonce }));
      child.unref();
      fs.closeSync(fd);
    },
    async observeReady() {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const ready = read("worker-ready");
        if (ready) {
          const after = await observe();
          if (
            ready.buildHash !== approval.buildHash ||
            !equal(ready.owner, after.owner) ||
            !equal(read("worker"), {
              pid: after.owner.pid,
              birth: after.owner.birth,
            })
          )
            fail("UPGRADE_START_UNPROVEN", "Worker/ready/owner mismatch");
          return after;
        }
        if (read("worker-error"))
          fail(
            "UPGRADE_START_FAILED",
            "Inspect original worker error; no SDK admission",
          );
        await sleep(100);
      }
      fail(
        "UPGRADE_START_UNKNOWN",
        "No ready receipt; no new launch or SDK permitted",
      );
    },
    async release() {
      for (const name of ["atomic-migration.lock", "recovery.lock"]) {
        const f = path.join(dir, name);
        if (fs.existsSync(f)) {
          if (!equal(api.readJson(f), marker()))
            fail("GUARD_CHANGED", "Never release another transaction");
          files.exclusive(
            path.join(audit, "released-" + name + ".json"),
            marker(),
          );
          fs.unlinkSync(f);
        }
      }
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
  try {
    console.log(
      JSON.stringify(
        await (
          settled ? createSettledEpochRuntimeUpgrade : createEpochRuntimeUpgrade
        )(ports)(),
        null,
        2,
      ),
    );
  } finally {
    client.dispose();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
