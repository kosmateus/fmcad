/** Structural contract of the worker's broker-owned SDK observation port. */
export interface WorkerSdkProbeRequest {
  readonly capabilityId: string;
  readonly backend: "mcp" | "addin";
  readonly documentIdentity: Readonly<{ docId?: string; docFileId?: string }>;
}

export interface WorkerSdkProbeEvidence {
  readonly capabilityId: string;
  readonly status: "partial" | "unsupported";
  readonly precision: "unknown";
  readonly coverage: "partial" | "unsupported";
  readonly build: string;
  readonly identity: "verified";
  readonly mutation: "none";
  readonly restoration: "not_applicable";
  readonly limitations: readonly string[];
}

export interface WorkerSdkProbePort {
  readonly boundary: "fmcad-broker";
  readonly kind: "sdk-probe";
  probe(request: WorkerSdkProbeRequest): Promise<WorkerSdkProbeEvidence>;
}

export interface WorkerSdkProbeTarget {
  readonly capabilityId: string;
  readonly doc: string;
  readonly docId?: string;
  readonly docFileId?: string;
}

/** A generic SDK probe observes runtime/build/identity and handler availability;
 * it never claims successful execution or geometry from registry membership. */
export function sdkProbeEvidence(
  request: WorkerSdkProbeRequest,
  registered: boolean,
  build: string,
): WorkerSdkProbeEvidence {
  return {
    capabilityId: request.capabilityId,
    status: registered ? "partial" : "unsupported",
    precision: "unknown",
    coverage: registered ? "partial" : "unsupported",
    build,
    identity: "verified",
    mutation: "none",
    restoration: "not_applicable",
    limitations: [
      "Observed the pinned document, native Fusion build and loaded runtime handler registry through one broker SDK turn.",
      "Handler availability is not behavioral execution, API precision, geometry/model validation, cloud permission or physical evidence.",
      "No target capability was executed, no mutation was requested, and no rollback/restoration claim is made.",
    ],
  };
}
