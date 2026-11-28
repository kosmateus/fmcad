import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TrustedAddinMetadataAdmission } from "./queue-broker-ports";
const load = createRequire(__filename);
const api = load("./queue-instance") as {
  processBirth(): string;
  readJson(file: string): unknown;
};
const files = load("./queue-atomic-migration-files") as {
  exclusive(file: string, value: unknown): void;
};
type BrokerHost = {
  serve(
    cfg: unknown,
    options: Record<string, unknown>,
  ): Promise<{ buildHash: string; close(): Promise<void> }>;
};
const host = () => load("./queue-broker") as BrokerHost;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Object-shaped successor startup input required");
  return value as Record<string, unknown>;
}
function errorCode(error: unknown): unknown {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)["code"]
    : undefined;
}
function metadataProvision(
  input: unknown,
  dir: string,
  audit: string,
  nonce: unknown,
): TrustedAddinMetadataAdmission | undefined {
  const refuse = (): never => {
    throw new Error("INVALID_SUCCESSOR_PROVISIONING");
  };
  const authorityFile = path.join(audit, "authority.json");
  let authority: Record<string, unknown>;
  let authorityBytes: Buffer;
  try {
    authorityBytes = fs.readFileSync(authorityFile);
    authority = object(JSON.parse(authorityBytes.toString("utf8")) as unknown);
  } catch {
    if (input === undefined && !fs.existsSync(authorityFile)) return undefined;
    return refuse();
  }
  if (authority["frozenMetadata"] === undefined) {
    if (input !== undefined) refuse();
    return undefined;
  }
  try {
    const profile = object(authority["frozenMetadata"]);
    const dto = object(input);
    const fields = [
      "capability",
      "owner",
      "endpoint",
      "token",
      "pid",
      "birth",
      "instance",
      "epoch",
      "source",
      "build",
    ];
    if (
      Object.keys(dto).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(dto, key)) ||
      fields
        .filter((key) => key !== "pid")
        .some(
          (key) => typeof dto[key] !== "string" || !(dto[key] as string).trim(),
        ) ||
      !Number.isSafeInteger(dto["pid"]) ||
      (dto["pid"] as number) <= 0 ||
      dto["capability"] !== "get_open_document_metadata" ||
      !/^[\x21-\x7e]{32,}$/.test(dto["token"] as string)
    )
      refuse();
    const endpoint = new URL(dto["endpoint"] as string);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.port !== "8765" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.pathname !== "/admission/v1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      refuse();
    const binding = Object.fromEntries(
      Object.entries(dto).filter(([key]) => key !== "token"),
    );
    const active = object(
      api.readJson(path.join(dir, "active-epoch-succession.json")),
    );
    const expectedRef = {
      path: authorityFile,
      sha256: createHash("sha256").update(authorityBytes).digest("hex"),
    };
    const expectedGuard = {
      kind: "dead-epoch-successor",
      nonce,
      audit,
      clientId: authority["clientId"],
    };
    if (
      profile["version"] !== 1 ||
      profile["purpose"] !== "dead-frozen-predecessor-metadata-v1" ||
      profile["beneficiary"] !== dto["owner"] ||
      typeof profile["metadataRequestId"] !== "string" ||
      !profile["metadataRequestId"] ||
      !isDeepStrictEqual(profile["provisioning"], binding) ||
      !isDeepStrictEqual(authority["expectedProcess"], {
        pid: dto["pid"],
        birth: dto["birth"],
      }) ||
      authority["version"] !== 1 ||
      authority["kind"] !== "owner-authenticated-dead-epoch-successor" ||
      typeof nonce !== "string" ||
      !nonce ||
      authority["nonce"] !== nonce ||
      typeof authority["clientId"] !== "string" ||
      !authority["clientId"] ||
      path.dirname(audit) !== path.join(dir, "epoch-successions") ||
      fs.realpathSync(audit) !== audit ||
      !isDeepStrictEqual(active, { version: 1, authority: expectedRef }) ||
      !isDeepStrictEqual(
        api.readJson(path.join(dir, "recovery.lock")),
        expectedGuard,
      ) ||
      !isDeepStrictEqual(
        api.readJson(path.join(dir, "atomic-migration.lock")),
        expectedGuard,
      )
    )
      refuse();
    return dto as unknown as TrustedAddinMetadataAdmission;
  } catch {
    return refuse();
  }
}
function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value))
    return value.some((item) => containsSecret(item, secret));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) => key.includes(secret) || containsSecret(item, secret),
    );
  return false;
}
async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("Successor worker configuration bound exceeded");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(text) as unknown);
  } catch {
    throw new Error("INVALID_SUCCESSOR_STARTUP_JSON");
  }
  const cfg = parsed["cfg"],
    dir = parsed["dir"],
    audit = parsed["audit"],
    nonce = parsed["nonce"],
    workerJournal = parsed["workerJournal"];
  if (typeof dir !== "string" || typeof audit !== "string")
    throw new Error("Successor worker directories required");
  if (
    workerJournal !== undefined &&
    (workerJournal !== path.join(audit, "retained-evaluator-handoff") ||
      typeof workerJournal !== "string")
  )
    throw new Error("Exact retained evaluator journal required");
  const journal = typeof workerJournal === "string" ? workerJournal : audit;
  const provisioning = metadataProvision(
    parsed["addinMetadataAdmission"],
    dir,
    audit,
    nonce,
  );
  if (
    provisioning &&
    (workerJournal !== undefined ||
      containsSecret(
        { ...parsed, addinMetadataAdmission: undefined },
        provisioning.token,
      ))
  )
    throw new Error("INVALID_SUCCESSOR_PROVISIONING");
  const owner = { pid: process.pid, birth: api.processBirth(), nonce };
  files.exclusive(path.join(journal, "worker-claim.json"), owner);
  try {
    const broker = await host().serve(cfg, {
      dir,
      confirmOwnership: true,
      deadEpochSuccessorNonce: nonce,
      autoReconcile: false,
      ...(provisioning ? { addinMetadataAdmission: provisioning } : {}),
    });
    const marker = api.readJson(path.join(dir, "broker.lock"));
    files.exclusive(path.join(journal, "worker-ready.json"), {
      nonce,
      owner: marker,
      buildHash: broker.buildHash,
      sdkRequestsSent: 0,
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        broker
          .close()
          .catch(() =>
            process.stderr.write("Broker remains reserved: CLOSE_REFUSED\n"),
          );
      });
  } catch (error) {
    files.exclusive(path.join(journal, "worker-error.json"), {
      nonce,
      code: provisioning
        ? "SUCCESSOR_START_FAILED"
        : errorCode(error) || "SUCCESSOR_START_FAILED",
    });
    if (provisioning) throw new Error("SUCCESSOR_START_FAILED");
    throw error;
  }
}
main().catch((error) => {
  process.stderr.write(
    String(
      errorCode(error) || (error instanceof Error ? error.message : error),
    ) + "\n",
  );
  process.exitCode = 1;
});
