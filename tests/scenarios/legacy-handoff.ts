import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import type { Document, Owner, ScenarioBackend } from "./contracts";
import { number, record, text } from "./contracts";

export interface LegacyLease {
  version: 1;
  owner: Owner;
  document: Document;
  directory: string;
  source: string;
  testCase: string;
  protocol: "mcp" | "addin";
  mode?: "owned-unsaved-script";
}
interface Invocation {
  version: 1;
  owner: Owner;
  requestId: string;
  argvHash: string;
  admissionRequested: boolean;
  completed: boolean;
  exitCode?: number;
  jobId?: string;
  pid?: number;
  birth?: string;
}
export function writeHandoff(
  filename: string,
  value: unknown,
  exclusive = false,
) {
  const target = exclusive ? filename : filename + ".new";
  const fd = fs.openSync(target, exclusive ? "wx" : "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!exclusive) fs.renameSync(target, filename);
}
function regular(filename: string): Record<string, unknown> {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid owned handoff record");
    return record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown);
  } finally {
    fs.closeSync(fd);
  }
}
export const childProcessIdentity = createRequire(
  path.resolve(__dirname, "../../..", "package.json"),
)("./src/queue-instance") as {
  processBirth(pid?: number): string;
  priorProcessAlive(identity: { pid: number; birth: string }): boolean | null;
};
export function beginCliIntent(env: NodeJS.ProcessEnv = process.env) {
  const invocation = ownedInvocation(env);
  if (!invocation) return;
  const { filename, current } = invocation;
  if (current["pid"] !== undefined || current["completed"] !== false)
    throw new Error("Original CLI driver was already started; never restart");
  current["pid"] = process.pid;
  current["birth"] = childProcessIdentity.processBirth();
  writeHandoff(filename, current);
}
function ownedInvocation(env: NodeJS.ProcessEnv) {
  const filename = env["FMCAD_LIVE_COMMAND_INTENT"];
  if (!filename) return undefined;
  const lease = ownedLease(env);
  if (
    !lease ||
    path.dirname(filename) !== path.join(lease.directory, "legacy", "intents")
  )
    throw new Error("Foreign command intent path");
  const current = regular(filename),
    owner = record(current["owner"]);
  if (
    current["version"] !== 1 ||
    owner["clientId"] !== lease.owner.clientId ||
    owner["runId"] !== lease.owner.runId ||
    owner["scenarioId"] !== lease.owner.scenarioId ||
    current["requestId"] !==
      lease.owner.clientId + ":legacy:" + path.basename(filename, ".json")
  )
    throw new Error("Foreign original CLI intent");
  return { filename, current, lease };
}
export function ownedLease(
  env: NodeJS.ProcessEnv = process.env,
): LegacyLease | undefined {
  const filename = env["FMCAD_LIVE_OWNED_SCOPE"];
  if (!filename) return undefined;
  const value = regular(filename),
    owner = record(value["owner"]),
    document = record(value["document"]);
  const directory = text(value["directory"]);
  if (
    value["version"] !== 1 ||
    path.resolve(filename) !== path.join(directory, "legacy", "lease.json") ||
    owner["clientId"] !== env["FMCAD_LIVE_CLIENT"] ||
    owner["clientId"] !==
      "scenario:" +
        String(owner["runId"]) +
        ":" +
        String(owner["scenarioId"]) ||
    document["name"] !== env["FMCAD_TEST_DOC"] ||
    (!document["file"] && value["mode"] !== "owned-unsaved-script") ||
    !["mcp", "addin"].includes(text(value["protocol"]))
  )
    throw new Error("Foreign or incomplete owned legacy scope");
  const creation = regular(path.join(directory, "creation.json"));
  if (
    creation["creationId"] !== document["creationId"] ||
    creation["name"] !== document["name"] ||
    creation["clientId"] !== owner["clientId"] ||
    !String(creation["requestId"]).startsWith(text(owner["clientId"]) + ":")
  )
    throw new Error("Owned legacy scope lacks its original creation receipt");
  const file =
      document["file"] === undefined ? undefined : record(document["file"]),
    version = file ? number(file["version"]) : undefined,
    protocol = text(value["protocol"]);
  if (
    (file && (!Number.isSafeInteger(version) || version! < 1)) ||
    (value["mode"] === "owned-unsaved-script" &&
      (file ||
        ![
          "tests/live-data-import.ts",
          "tests/scenarios/legacy-owned-driver.ts",
        ].includes(String(value["source"])))) ||
    (protocol !== "mcp" && protocol !== "addin")
  )
    throw new Error("Invalid owned saved fixture version or protocol");
  return {
    version: 1,
    owner: {
      runId: text(owner["runId"]),
      scenarioId: text(owner["scenarioId"]),
      clientId: text(owner["clientId"]),
    },
    document: {
      creationId: text(document["creationId"]),
      name: text(document["name"]),
      ...(file
        ? {
            file: {
              fileId: text(file["fileId"]),
              projectId: text(file["projectId"]),
              folderId: text(file["folderId"]),
              version: version!,
            },
          }
        : {}),
    },
    directory,
    source: text(value["source"]),
    testCase: text(value["testCase"]),
    protocol,
    ...(value["mode"] === "owned-unsaved-script"
      ? { mode: "owned-unsaved-script" as const }
      : {}),
  };
}
export function reserveCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const lease = ownedLease(env);
  if (!lease) return undefined;
  const words = [...args];
  const pin = (flag: string, value: string) => {
    const positions = words.flatMap((word, index) =>
      word === flag ? [index] : [],
    );
    if (
      positions.length > 1 ||
      (positions.length === 1 && words[positions[0]! + 1] !== value)
    )
      throw new Error("Foreign legacy CLI pin: " + flag);
    if (!positions.length) words.push(flag, value);
  };
  pin("--doc", lease.document.name);
  pin("--doc-id", lease.document.creationId);
  if (lease.document.file) pin("--doc-file-id", lease.document.file.fileId);
  else if (words.includes("--doc-file-id"))
    throw new Error("Unsaved owned fixture cannot accept a cloud file pin");
  pin("--routing", "queue");
  pin("--client", lease.owner.clientId);
  pin("--backend", lease.protocol);
  if (words.includes("--request-id"))
    throw new Error("Legacy request identity is owned by the runner");
  const id = randomUUID(),
    requestId = lease.owner.clientId + ":legacy:" + id;
  words.push("--request-id", requestId);
  const filename = path.join(
    lease.directory,
    "legacy",
    "intents",
    id + ".json",
  );
  const intent: Invocation = {
    version: 1,
    owner: lease.owner,
    requestId,
    argvHash: createHash("sha256").update(JSON.stringify(words)).digest("hex"),
    admissionRequested: false,
    completed: false,
  };
  writeHandoff(filename, intent, true);
  return { words, filename };
}
/** Called by the existing real CLI driver before its queue request callback returns. */
export function observeCliIntent(
  chunk: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const invocation = ownedInvocation(env);
  if (!invocation) return;
  const { filename, current, lease } = invocation;
  for (const line of chunk.split(/\r?\n/u)) {
    if (!line.startsWith("FMCAD_QUEUE_REQUEST ")) continue;
    const request = record(
      JSON.parse(line.slice("FMCAD_QUEUE_REQUEST ".length)) as unknown,
    );
    if (
      request["requestId"] !== current["requestId"] ||
      request["clientId"] !== lease.owner.clientId
    )
      throw new Error("Foreign original CLI queue request");
    current["admissionRequested"] = true;
    writeHandoff(filename, current);
  }
}
export function finishCliIntent(
  code: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const invocation = ownedInvocation(env);
  if (!invocation) return;
  const { filename, current } = invocation;
  current["completed"] = true;
  current["exitCode"] = code;
  writeHandoff(filename, current);
}
export function legacyIntents(directory: string, owner: Owner) {
  const folder = path.join(directory, "legacy", "intents");
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name))
        throw new Error("Invalid legacy intent name");
      const value = regular(path.join(folder, name)),
        identity = record(value["owner"]);
      if (
        value["version"] !== 1 ||
        identity["clientId"] !== owner.clientId ||
        identity["runId"] !== owner.runId ||
        identity["scenarioId"] !== owner.scenarioId ||
        value["requestId"] !== owner.clientId + ":legacy:" + name.slice(0, -5)
      )
        throw new Error("Foreign legacy invocation intent");
      if (
        typeof value["admissionRequested"] !== "boolean" ||
        typeof value["completed"] !== "boolean" ||
        !/^[a-f0-9]{64}$/u.test(text(value["argvHash"]))
      )
        throw new Error("Invalid original CLI admission intent");
      const result: Invocation = {
        version: 1,
        owner,
        requestId: text(value["requestId"]),
        argvHash: text(value["argvHash"]),
        admissionRequested: value["admissionRequested"],
        completed: value["completed"],
      };
      if (value["pid"] !== undefined) result.pid = number(value["pid"]);
      if (value["birth"] !== undefined) result.birth = text(value["birth"]);
      if (value["exitCode"] !== undefined)
        result.exitCode = number(value["exitCode"]);
      return result;
    });
}
export async function recoverLegacyInvocations(
  backend: ScenarioBackend,
  directory: string,
  owner: Owner,
) {
  if (!backend.lookup)
    throw new Error("Owned child CLI requires original request lookup");
  assertLegacyChildExited(directory, childProcessIdentity.priorProcessAlive);
  const requests = [];
  for (const intent of legacyIntents(directory, owner)) {
    if (
      typeof intent.pid !== "number" ||
      typeof intent.birth !== "string" ||
      childProcessIdentity.priorProcessAlive({
        pid: intent.pid,
        birth: intent.birth,
      }) !== false
    )
      throw new Error(
        "Original legacy CLI process may still submit work; cleanup deferred",
      );
    if (intent.completed && !intent.admissionRequested) continue; // Real CLI returned before its before-admission callback.
    const result = await backend.lookup(owner, intent.requestId);
    if (
      !result ||
      result.requestId !== intent.requestId ||
      !result.sdkSettled ||
      result.state === "unknown"
    )
      throw new Error(
        "Original legacy request remains unsettled; cleanup deferred: " +
          intent.requestId,
      );
    requests.push({ requestId: intent.requestId, phase: "legacy-cli", result });
  }
  return requests;
}

/** Refuse recovery while the original child might still submit work. */
export function assertLegacyChildExited(
  directory: string,
  alive: (identity: { pid: number; birth: string }) => boolean | null,
) {
  const filename = path.join(directory, "legacy", "launch.json");
  if (!fs.existsSync(filename)) return;
  const value = regular(filename);
  if (
    !["running", "completed"].includes(String(value["state"])) ||
    typeof value["pid"] !== "number" ||
    typeof value["birth"] !== "string" ||
    alive({ pid: value["pid"], birth: value["birth"] }) !== false
  )
    throw new Error(
      "Original legacy child may still submit work; cleanup deferred",
    );
}
