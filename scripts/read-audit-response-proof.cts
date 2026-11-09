#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// No IPC/HTTP/SDK port. Authenticate existing owner credentials locally and
// publish a new derived proof outside the queue without editing its evidence.
const load = createRequire(__filename);
interface LocalConfig {
  queue?: { client?: string };
}
interface ReadOnlyClient {
  dir: string;
  auth: { clientId: string; clientToken: string };
  dispose(): void;
}
interface Scope {
  jobId: string;
  observationJobId: string;
}
interface Proof extends Record<string, unknown> {
  key: { requestId: string; clientId: string };
}
interface LocalApi {
  buildHash(runtime: string): string;
  hash(value: string | Uint8Array): string;
  readJson(file: string, limit?: number): unknown;
  durable(file: string, value: unknown, exclusive: boolean): void;
}
interface ProofApi {
  collectAuditResponseFiles(
    dir: string,
    migration: string,
    scope: Scope,
  ): unknown;
  auditResponseProof(files: unknown, dir: string, scope: Scope): Proof;
  auditResponseProofStillCurrent(proof: Proof): boolean;
}
const readerRoot = fs.existsSync(
  path.join(__dirname, "../src/queue-audit-response-proof.js"),
)
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "../dist");
const api = load(readerRoot + "/src/queue-instance") as LocalApi;
const proofApi = load(
  readerRoot + "/src/queue-audit-response-proof",
) as ProofApi;
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(
      "AUDIT_RESPONSE_PROOF_INVALID",
      "Expected object-shaped original evidence",
    );
  return value as Record<string, unknown>;
}
function main(): void {
  const options: Record<string, string> = {},
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      ![
        "--runtime",
        "--migration-audit",
        "--request-id",
        "--output",
        "--config",
      ].includes(key) ||
      options[key] ||
      !value ||
      value.startsWith("--")
    )
      fail(
        "INVALID_REQUEST",
        "Exact runtime/migration/request/output required; no client override",
      );
    options[key] = value;
  }
  const runtime = options["--runtime"],
    output = options["--output"];
  const migrationAudit = options["--migration-audit"],
    requestId = options["--request-id"];
  if (
    !runtime ||
    !output ||
    !migrationAudit ||
    !requestId ||
    !path.isAbsolute(runtime) ||
    !path.isAbsolute(output) ||
    !path.isAbsolute(migrationAudit) ||
    api.buildHash(runtime) !==
      "14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d"
  )
    fail(
      "BUILD_CHANGED",
      "This file-only reader requires the exact frozen qualified 843 producer",
    );
  const configuration = load(runtime + "/src/config") as {
    loadConfig(options: { config: string | undefined }): { cfg: LocalConfig };
  };
  const { cfg } = configuration.loadConfig({ config: options["--config"] });
  const clientsModule = load(runtime + "/src/queue-client") as {
    QueueClient: new (
      name: string | undefined,
      options: { cfg: LocalConfig; existingCredentialsOnly: true },
    ) => ReadOnlyClient;
  };
  const client = new clientsModule.QueueClient(
    process.env["FMCAD_CLIENT"] || cfg.queue?.client,
    { cfg, existingCredentialsOnly: true },
  );
  try {
    const dir = client.dir,
      migration = object(
        api.readJson(path.join(migrationAudit, "intent.json")),
      );
    const token = api.hash(client.auth.clientToken),
      clients = object(api.readJson(path.join(dir, "clients.json")));
    if (
      object(migration["binding"])["clientId"] !== client.auth.clientId ||
      migration["ownerTokenHash"] !== token ||
      clients[client.auth.clientId] !== token
    )
      fail(
        "NOT_OWNER",
        "Only existing private credentials of the original migration/audit owner can publish this derived read",
      );
    const observation = load(runtime + "/src/atomic-workflow-observation") as {
      fastenersScope: Scope;
    };
    const scope = {
      ...observation.fastenersScope,
      observationJobId: "3627db2e-0b9d-4e4f-927f-20cb45deae74",
    };
    const state = object(
      api.readJson(path.join(dir, "queue-state.json"), 256 * 1024 * 1024),
    );
    const jobs = object(state["jobs"]);
    for (const id of [scope.jobId, scope.observationJobId]) {
      const job = object(jobs[id]);
      if (
        job["clientId"] !== client.auth.clientId ||
        object(job["request"])["ownerToken"] !== token
      )
        fail(
          "NOT_OWNER",
          "Original target and observer must remain owned by this credential",
        );
    }
    const files = proofApi.collectAuditResponseFiles(
      dir,
      migrationAudit,
      scope,
    );
    const proof = proofApi.auditResponseProof(files, dir, scope);
    if (
      proof.key.requestId !== requestId ||
      proof.key.clientId !== client.auth.clientId
    )
      fail(
        "AUDIT_RESPONSE_PROOF_INVALID",
        "Request/owner does not match the original failed audit",
      );
    const resolved = path.resolve(output);
    if (
      resolved === dir ||
      resolved.startsWith(dir + path.sep) ||
      resolved === runtime ||
      resolved.startsWith(runtime + path.sep)
    )
      fail(
        "INVALID_OUTPUT",
        "Publish outside the protected queue and frozen runtime",
      );
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    if (
      fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved) ||
      !proofApi.auditResponseProofStillCurrent(proof)
    )
      fail(
        "AUDIT_RESPONSE_PROOF_INVALID",
        "Output path or original evidence changed",
      );
    const derived = {
      ...proof,
      derivedAt: new Date().toISOString(),
      writerClientId: client.auth.clientId,
      writerAuthenticated: true,
      readerScriptSha256: api.hash(fs.readFileSync(__filename)),
      readerModuleSha256: api.hash(
        fs.readFileSync(
          load.resolve(readerRoot + "/src/queue-audit-response-proof"),
        ),
      ),
    };
    api.durable(resolved, derived, true);
    console.log(
      JSON.stringify(
        {
          path: resolved,
          sha256: api.hash(fs.readFileSync(resolved)),
          factsAvailable: false,
          epochEligible: false,
          sdkRequestsSent: 0,
          historicalOutcome: "unknown",
        },
        null,
        2,
      ),
    );
  } finally {
    client.dispose();
  }
}
try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
