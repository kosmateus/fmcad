import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { verifyRetainedAuditResponse } from "./recovery-audit";
import type { RetainedAuditInput } from "./recovery-audit";

type Data = Record<string, unknown>;
interface Reference {
  path: string;
  sha256: string;
}
export interface SubmittedAuditInventoryInput extends RetainedAuditInput {
  root: string;
  owner: { pid: number; birth: string };
}
export interface SubmittedAuditInventory {
  files: Reference[];
  inventory: Array<{ path: string; entries: string[] }>;
  selectedProcess: { pid: number; birth: string };
  sdkRequestsSent: 1;
  allLiveSdkTerminal: true;
  archiveBoundaries: Array<{
    path: string;
    backup: Reference;
    manifest: Reference;
    identity: Reference;
    process: { pid: number; birth: string };
  }>;
}
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "RETAINED_DISPATCH_UNPROVEN",
  });
}
function object(v: unknown): Data {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail("Submitted evidence object required");
  return v as Data;
}
function read(p: string): Data {
  return object(JSON.parse(fs.readFileSync(p, "utf8")) as unknown);
}
function ref(p: string): Reference {
  if (
    !path.isAbsolute(p) ||
    fs.realpathSync(p) !== p ||
    !fs.lstatSync(p).isFile()
  )
    fail("Canonical regular submitted evidence required");
  return {
    path: p,
    sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
  };
}

/** Read-only inventory, not a freeze or admission grant. The composition must
 * separately certify its exact durable-before-send source/role, freeze the
 * process, repeat this cut and prove fresh identical process/owner/sequence.
 * The only allowed live-SDK turn is independently revalidated here, not inferred
 * from a filename, HTTP 200, an empty directory or caller-provided boolean. */
export function inspectSubmittedAuditInventory(
  input: SubmittedAuditInventoryInput,
  ports: { priorProcessAlive(v: unknown): boolean | null },
): SubmittedAuditInventory {
  const auditDirectory = path.dirname(input.directory);
  if (
    input.directory !==
      path.join(auditDirectory, "dead-epoch-current-observation") ||
    path.dirname(auditDirectory) !==
      path.join(input.root, "epoch-successions") ||
    fs.realpathSync(input.root) !== input.root
  )
    fail("Exact pending successor inventory namespace required");
  const verified = verifyRetainedAuditResponse(input),
    expectedStart = verified.files["start.json"]!.path,
    expectedRemote = String(verified.start["receipt"]),
    ownJournal = path.join(auditDirectory, "retained-evaluator-handoff"),
    roots = [
      "jobs",
      "admission-epochs",
      "epoch-successions",
      "atomic-migrations",
      "epoch-runtime-upgrades",
      "isolated-scratch-qualification",
      "accepted",
      "admissions",
      "autostart",
      "physical-backend-transitions",
    ],
    files: Reference[] = [],
    archiveBoundaries: SubmittedAuditInventory["archiveBoundaries"] = [],
    inventory: Array<{ path: string; entries: string[] }> = [],
    oldSdkChecks = new Set<string>();
  let liveStarts = 0,
    count = 0;
  const sameProcess = (v: unknown) =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (v as Data)["pid"] === input.instance.pid &&
    (v as Data)["birth"] === input.instance.birth;
  const regular = (p: string, name: string): void => {
    files.push(ref(p));
    if (name === "sdk-facts.json.started") {
      const marker = read(p),
        directory = path.dirname(p),
        intent = read(path.join(directory, "intent.json")),
        start = read(path.join(directory, "start.json")),
        binding = object(intent["binding"]),
        physical = object(start["binding"]),
        sdk = object(start["instance"]),
        key = canonicalHash({ pid: sdk["pid"], birth: sdk["birth"] });
      if (
        Object.keys(marker).sort().join(",") !== "bindingHash,originalRpcId" ||
        typeof marker["originalRpcId"] !== "string" ||
        !marker["originalRpcId"] ||
        marker["bindingHash"] !== canonicalHash(binding) ||
        marker["bindingHash"] !== physical["auditBindingHash"] ||
        marker["originalRpcId"] !== binding["originalRpcId"] ||
        sameProcess(sdk) ||
        physical["buildHash"] === input.buildHash
      )
        fail("Unbound or live-SDK facts-capture sidecar: " + p);
      if (!oldSdkChecks.has(key)) {
        if (ports.priorProcessAlive(sdk) !== false)
          fail("Facts-capture SDK identity is live or unknown: " + p);
        oldSdkChecks.add(key);
      }
      return;
    }
    if (
      /^(?:sdk-qualified\.json\.(?:started|created)|sdk-closed\.json\.started)$/.test(
        name,
      )
    ) {
      const marker = read(p),
        directory = path.dirname(p),
        intent = read(path.join(directory, "intent.json")),
        start = read(path.join(directory, "start.json")),
        binding = object(intent["binding"]),
        physical = object(start["binding"]),
        oldSdk = object(start["instance"]),
        oldKey = canonicalHash({ pid: oldSdk["pid"], birth: oldSdk["birth"] }),
        keys =
          name === "sdk-qualified.json.created"
            ? "bindingHash,creationId,epochId"
            : name === "sdk-qualified.json.started"
              ? "bindingHash,epochId"
              : "bindingHash,document";
      if (!oldSdkChecks.has(oldKey)) {
        if (
          !Number.isSafeInteger(oldSdk["pid"]) ||
          Number(oldSdk["pid"]) <= 0 ||
          typeof oldSdk["birth"] !== "string" ||
          !oldSdk["birth"] ||
          ports.priorProcessAlive(oldSdk) !== false
        )
          fail("Historical scratch SDK identity is live or unproven: " + p);
        oldSdkChecks.add(oldKey);
      }
      if (
        Object.keys(marker).sort().join(",") !== keys ||
        (name.endsWith(".created") &&
          typeof marker["creationId"] !== "string") ||
        marker["bindingHash"] !== canonicalHash(binding) ||
        marker["bindingHash"] !== physical["auditBindingHash"] ||
        sameProcess(start["instance"]) ||
        physical["buildHash"] === input.buildHash ||
        (name.startsWith("sdk-qualified") &&
          marker["epochId"] !== binding["epochId"]) ||
        (name.startsWith("sdk-closed") &&
          !same(marker["document"], binding["document"]))
      )
        fail(
          "Scratch sidecar is unbound or belongs to the selected live SDK: " +
            p,
        );
      // This preserves an old started/created marker; it does not settle it.
      return;
    }
    if (
      /^(adapter-worker|closed-pause-continuation-worker)\.json\.[a-f0-9]{24}\.finished$/.test(
        name,
      )
    ) {
      const marker = read(p);
      const continuation = name.startsWith("closed-pause-continuation-worker"),
        intent = continuation
          ? read(path.join(path.dirname(p), "intent.json"))
          : null;
      if (
        !Number.isSafeInteger(marker["pid"]) ||
        Number(marker["pid"]) <= 1 ||
        typeof marker["birth"] !== "string" ||
        !marker["birth"] ||
        typeof marker["nonce"] !== "string" ||
        !marker["nonce"] ||
        Object.keys(marker).sort().join(",") !==
          (continuation ? "birth,nonce,pid,requestId" : "birth,nonce,pid") ||
        (continuation &&
          (!intent ||
            typeof marker["requestId"] !== "string" ||
            !marker["requestId"] ||
            marker["nonce"] !== intent["nonce"] ||
            marker["requestId"] !== object(intent["binding"])["requestId"])) ||
        ports.priorProcessAlive(marker) !== false
      )
        fail("Historical worker completion is unbound or still live: " + p);
      return;
    }
    const nativeName =
      /^remote-([a-f0-9-]{36})\.json\.native-(start|end)\.json$/.exec(name);
    if (nativeName) {
      const value = read(p),
        descriptor = read(
          path.join(path.dirname(p), "rpc-" + nativeName[1] + ".json"),
        ),
        binding = object(descriptor["binding"]),
        sdk = object(descriptor["instance"]),
        observed = object(value["instance"]),
        oldKey = canonicalHash({ pid: sdk["pid"], birth: sdk["birth"] });
      if (
        value["rpcId"] !== nativeName[1] ||
        value["jobId"] !== path.basename(path.dirname(p)) ||
        Object.entries(binding).some(([key, v]) => !same(value[key], v)) ||
        observed["pid"] !== sdk["pid"] ||
        observed["birth"] !== sdk["birth"] ||
        observed["version"] !== sdk["version"] ||
        sameProcess(observed) ||
        value["buildHash"] === input.buildHash ||
        value["stage"] !==
          (nativeName[2] === "start" ? "native-start" : "native-completion") ||
        value["terminal"] !== (nativeName[2] === "end")
      )
        fail("Unbound or live-SDK native lifecycle sidecar: " + p);
      if (!oldSdkChecks.has(oldKey)) {
        if (ports.priorProcessAlive(sdk) !== false)
          fail("Native sidecar SDK identity is live or unknown: " + p);
        oldSdkChecks.add(oldKey);
      }
      // Even a native completion does not settle a quarantined historical job.
      return;
    }
    if (/\.tmp(?:\.|$)|\.partial(?:\.|$)|\.json\./.test(name))
      fail("Partial submitted evidence: " + p);
    if (!name.endsWith(".json")) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const value = parsed as Data,
      binding = value["binding"];
    if (
      typeof value["rpcId"] === "string" &&
      (sameProcess(value["instance"]) ||
        value["buildHash"] === input.buildHash) &&
      p !== expectedRemote
    )
      fail("Unaccounted live-SDK terminal or unknown receipt: " + p);
    if (!binding || typeof binding !== "object" || Array.isArray(binding))
      return;
    const b = binding as Data;
    if (typeof b["rpcId"] !== "string") return;
    const live =
      sameProcess(value["instance"]) ||
      sameProcess(b["auditExpectedProcess"]) ||
      sameProcess(b["auditExpectedInstance"]);
    if (!live && b["buildHash"] !== input.buildHash) return;
    const producer =
      name === "start.json" ||
      /^rpc-.*\.json$/.test(name) ||
      /^(preflight|postflight)-start\.json$/.test(name) ||
      /^reconcile-probe(?:-.*)?\.json$/.test(name) ||
      name === "control-resume.json";
    if (!producer) {
      if (p !== path.join(input.directory, "received-response.json"))
        fail("Unaccounted live-SDK bound response: " + p);
      return;
    }
    if (!live || p !== expectedStart)
      fail("Subsequent, ambiguous or unaccounted SDK producer: " + p);
    liveStarts++;
  };
  const scan = (directory: string, depth = 0): void => {
    if (
      depth > 24 ||
      ++count > 100000 ||
      fs.realpathSync(directory) !== directory ||
      !fs.lstatSync(directory).isDirectory()
    )
      fail("Canonical bounded submitted namespace required");
    // A source-defined atomic migration backup is an immutable historical
    // snapshot, never a live SDK producer namespace. Bind its existing manifest
    // and old SDK identity; do not traverse recursive backups or credential
    // copies, and do not turn its old unknown work into terminal SDK evidence.
    if (
      path.basename(directory) === "queue-backup" &&
      path.dirname(path.dirname(directory)) ===
        path.join(input.root, "atomic-migrations") &&
      /^[a-f0-9]{64}$/.test(path.basename(path.dirname(directory)))
    ) {
      const parent = path.dirname(directory),
        backupRef = ref(path.join(parent, "backup.json")),
        backup = read(backupRef.path),
        manifestRef = ref(path.join(parent, "backup-manifest.json")),
        manifest = read(manifestRef.path),
        queue = object(manifest["queue"]),
        entries = queue["entries"],
        identityRef = ref(path.join(directory, "instance.json")),
        identity = read(identityRef.path),
        sdk = object(identity["instance"]);
      if (
        backup["audit"] !== parent ||
        backup["manifest"] !== "backup-manifest.json" ||
        backup["sha256"] !== manifestRef.sha256 ||
        !Array.isArray(entries) ||
        queue["sha256"] !==
          createHash("sha256").update(JSON.stringify(entries)).digest("hex") ||
        !entries.some(
          (row) =>
            object(row)["path"] === "instance.json" &&
            object(row)["sha256"] === identityRef.sha256,
        ) ||
        sameProcess(sdk) ||
        !Number.isSafeInteger(sdk["pid"]) ||
        typeof sdk["birth"] !== "string"
      )
        fail(
          "Unbound historical backup or selected-live-SDK archive: " +
            directory,
        );
      const key = canonicalHash({ pid: sdk["pid"], birth: sdk["birth"] });
      if (!oldSdkChecks.has(key)) {
        if (ports.priorProcessAlive(sdk) !== false)
          fail("Backup SDK identity is live or unknown: " + directory);
        oldSdkChecks.add(key);
      }
      files.push(backupRef, manifestRef, identityRef);
      archiveBoundaries.push({
        path: directory,
        backup: backupRef,
        manifest: manifestRef,
        identity: identityRef,
        process: { pid: Number(sdk["pid"]), birth: String(sdk["birth"]) },
      });
      return;
    }
    const entries = fs
      .readdirSync(directory)
      .sort()
      .filter((name) => path.join(directory, name) !== ownJournal);
    inventory.push({ path: directory, entries });
    for (const name of entries) {
      const p = path.join(directory, name),
        stat = fs.lstatSync(p);
      if (name === "client-credentials" || name === "clients.json") continue;
      if (stat.isSymbolicLink()) fail("Linked submitted namespace: " + p);
      if (stat.isDirectory()) scan(p, depth + 1);
      else if (stat.isFile()) regular(p, name);
      else if (!stat.isSocket()) fail("Unexplained submitted entry: " + p);
    }
  };
  const rootEntries = fs.readdirSync(input.root).sort();
  inventory.push({ path: input.root, entries: rootEntries });
  for (const name of rootEntries) {
    const p = path.join(input.root, name);
    if (roots.includes(name)) scan(p);
    else if (
      name !== "clients.json" &&
      name !== "client-credentials" &&
      fs.lstatSync(p).isFile() &&
      name.endsWith(".json")
    )
      regular(p, name);
  }
  if (liveStarts !== 1)
    fail("Exactly one verified selected live-SDK turn required");
  return {
    files,
    inventory,
    selectedProcess: input.instance,
    sdkRequestsSent: 1,
    allLiveSdkTerminal: true,
    archiveBoundaries,
  };
}
