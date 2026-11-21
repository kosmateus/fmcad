import { createHash } from "node:crypto";
import type { JsonValue } from "../../../core/src/domain/contracts";

export type AdmissionIdentity = Readonly<{
  owner: string;
  request: string;
  instance: string;
  epoch: string;
  source: string;
  build: string;
  /** Exact target descriptor, including file/version when applicable. */
  document: string;
}>;

export type AdmissionBinding = AdmissionIdentity &
  Readonly<{ version: 1; inputHash: string }>;

export type AdmissionRecord =
  | { state: "accepted" | "withdrawn" | "unknown" }
  | { state: "terminal"; result: JsonValue };

const identityKeys = [
  "owner",
  "request",
  "instance",
  "epoch",
  "source",
  "build",
  "document",
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string): Error {
  return Object.assign(new Error(message), {
    code: "ADDIN_ADMISSION_UNCERTAIN",
  });
}

/**
 * One immutable admission handle. A transport failure never retries a mutation:
 * callers may inspect status or request a durable withdrawal using this key.
 */
export function createAddinAdmission(
  options: { endpoint: string; token: string; timeoutMs?: number },
  identity: AdmissionIdentity,
  payload: Record<string, JsonValue>,
) {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/admission/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Admission requires an explicit loopback HTTP endpoint");
  if (!/^[\x21-\x7e]{32,}$/.test(options.token))
    throw new Error("Invalid admission credential");
  const timeoutMs = options.timeoutMs ?? 125_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid admission timeout");
  if (
    Object.keys(identity).length !== identityKeys.length ||
    identityKeys.some(
      (key) => typeof identity[key] !== "string" || !identity[key],
    )
  )
    throw new Error("Exact admission identity required");
  // Hash the actual UTF-8 input, not two languages' different JSON serializers.
  const payloadJson = JSON.stringify(payload, (_key, value: unknown) => {
    if (
      typeof value === "undefined" ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint" ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Admission input must contain only JSON values");
    return value;
  });
  if (!payloadJson || !object(JSON.parse(payloadJson)))
    throw new Error("Admission payload must be a JSON object");
  const binding: AdmissionBinding = Object.freeze({
    ...identity,
    version: 1,
    inputHash: createHash("sha256").update(payloadJson, "utf8").digest("hex"),
  });
  const token = options.token;

  async function call(operation: "admit" | "status" | "withdraw") {
    let response: Response;
    let decoded: unknown;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          operation,
          binding,
          ...(operation === "admit" ? { payloadJson } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw failure(`Admission HTTP ${response.status}; do not resubmit`);
      decoded = await response.json();
    } catch {
      // Do not leak credentials or interpret transport failure as no effect.
      throw failure("Admission outcome unavailable; inspect the original key");
    }
    if (
      !object(decoded) ||
      decoded["version"] !== 1 ||
      !object(decoded["binding"])
    )
      throw failure("Invalid admission response");
    const returned = decoded["binding"];
    const keys = Object.keys(binding) as (keyof AdmissionBinding)[];
    if (
      Object.keys(returned).length !== keys.length ||
      keys.some((key) => returned[key] !== binding[key])
    )
      throw failure("Admission response identity mismatch");
    const record = decoded["record"];
    if (record === null && operation === "status") return null;
    if (!object(record)) throw failure("Missing admission record");
    if (
      record["state"] === "terminal" &&
      Object.hasOwn(record, "result") &&
      Object.keys(record).length === 2
    )
      return record as AdmissionRecord;
    if (
      typeof record["state"] === "string" &&
      ["accepted", "withdrawn", "unknown"].includes(record["state"]) &&
      Object.keys(record).length === 1
    )
      return record as AdmissionRecord;
    throw failure("Invalid admission record");
  }

  return Object.freeze({
    binding,
    admit: () => call("admit"),
    status: () => call("status"),
    withdraw: () => call("withdraw"),
  });
}
