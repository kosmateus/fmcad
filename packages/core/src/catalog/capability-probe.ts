import { isEvidenceStatus } from "../domain/evidence";
import type { EvidenceStatus } from "../domain/contracts";

export interface CapabilityProbeRequest {
  readonly capabilityId: string;
  readonly backend: "mcp" | "addin";
  readonly documentIdentity: Readonly<{
    docId?: string;
    docFileId?: string;
  }>;
}

export interface CapabilityProbeEvidence {
  readonly capabilityId: string;
  readonly status: EvidenceStatus;
  readonly precision: EvidenceStatus;
  readonly coverage: EvidenceStatus;
  readonly build: string | null;
  readonly identity: "verified" | "mismatch" | "unknown" | "not_required";
  readonly mutation: "none" | "possible" | "unknown";
  readonly restoration: "not_applicable" | "verified" | "failed" | "unknown";
  readonly limitations: readonly string[];
}

/** Only the composition root that owns broker admission may supply this port. */
export interface BrokerSdkProbePort {
  readonly boundary: "fmcad-broker";
  readonly kind: "sdk-probe";
  probe(request: CapabilityProbeRequest): Promise<CapabilityProbeEvidence>;
}

export function validateCapabilityProbeInput(input: unknown): asserts input is {
  capabilityId: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Capability probe input must be an object");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== "capabilityId") ||
    typeof value["capabilityId"] !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(value["capabilityId"])
  )
    throw new Error("Capability probe requires a registered capabilityId");
}

export function validateCapabilityProbeIdentity(
  identity: unknown,
): asserts identity is {
  docId?: string;
  docFileId?: string;
} {
  if (!identity || typeof identity !== "object" || Array.isArray(identity))
    throw new Error("SDK capability probe requires a pinned document identity");
  const value = identity as Record<string, unknown>;
  const unknown = Object.keys(value).filter(
    (key) => !["docId", "docFileId"].includes(key),
  );
  const pins = ["docId", "docFileId"]
    .filter((key) => Object.hasOwn(value, key) && value[key] !== undefined)
    .map((key) => value[key]);
  if (
    unknown.length ||
    pins.length === 0 ||
    pins.some(
      (pin) =>
        typeof pin !== "string" ||
        pin.length === 0 ||
        pin.length > 256 ||
        /[\x00-\x20\x7f]/u.test(pin),
    )
  )
    throw new Error(
      "SDK capability probe requires a valid pinned document identity",
    );
}

/** Explicit native SDK probe. It neither creates a backend nor retries a turn. */
export async function probeCapability(
  port: BrokerSdkProbePort,
  request: CapabilityProbeRequest,
) {
  if (
    !port ||
    port.boundary !== "fmcad-broker" ||
    port.kind !== "sdk-probe" ||
    typeof port.probe !== "function"
  )
    throw new Error(
      "SDK capability probe requires the explicit fmcad broker port",
    );
  if (
    typeof request?.capabilityId !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(request.capabilityId) ||
    !["mcp", "addin"].includes(request.backend)
  )
    throw new Error("Invalid SDK capability probe request");
  validateCapabilityProbeIdentity(request.documentIdentity);
  const evidence = await port.probe(request);
  if (
    !evidence ||
    evidence.capabilityId !== request.capabilityId ||
    !isEvidenceStatus(evidence.status) ||
    !isEvidenceStatus(evidence.precision) ||
    !isEvidenceStatus(evidence.coverage) ||
    (evidence.build !== null && typeof evidence.build !== "string") ||
    !["verified", "mismatch", "unknown", "not_required"].includes(
      evidence.identity,
    ) ||
    !["none", "possible", "unknown"].includes(evidence.mutation) ||
    !["not_applicable", "verified", "failed", "unknown"].includes(
      evidence.restoration,
    ) ||
    !Array.isArray(evidence.limitations) ||
    evidence.limitations.some((item) => typeof item !== "string")
  )
    throw new Error("Broker SDK probe returned invalid or mismatched evidence");
  return {
    ...evidence,
    source: "broker-sdk-probe" as const,
    backend: request.backend,
  };
}
