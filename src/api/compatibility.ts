import type { ContractVersions } from "./contracts";

export const contractVersions: ContractVersions = Object.freeze({
  api: 1,
  dto: 1,
  broker: 2,
  persistedState: 1,
  pythonEnvelope: 1,
  controlApi: 1,
});

interface ConfigurationMismatchDetails {
  readonly backend: string;
  readonly transport: string;
  readonly tool: string;
}

function safeHash(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : "<unavailable>";
}

function safeLabel(value: string): string {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : "<redacted>";
}

export class CompatibilityError extends Error {
  readonly code = "FMCAD_INCOMPATIBLE_CONTRACT";
  constructor(
    readonly boundary: string,
    readonly received: unknown,
    readonly supported: unknown,
    configuration?: ConfigurationMismatchDetails,
  ) {
    const message =
      boundary === "configuration" && configuration
        ? `Unsupported fmcad configuration contract (FMCAD_CONFIGURATION_MISMATCH): broker configHash=${safeHash(received)} does not match client configHash=${safeHash(supported)}; client backend=${safeLabel(configuration.backend)}, transport=${safeLabel(configuration.transport)}, tool=${safeLabel(configuration.tool)}. Broker backend, transport and tool are not stored in its identity; use the same connection settings as the running broker.`
        : `Unsupported fmcad ${boundary} contract; upgrade client and broker together before retrying`;
    super(message);
    this.name = "CompatibilityError";
  }
}

/** Strict major negotiation; optional metadata is additive, missing versions are not guessed. */
export function assertCompatibility(
  value: unknown,
): asserts value is ContractVersions {
  if (!value || typeof value !== "object")
    throw new CompatibilityError("manifest", value, contractVersions);
  const versions = value as Record<string, unknown>;
  for (const [key, supported] of Object.entries(contractVersions)) {
    if (versions[key] !== supported)
      throw new CompatibilityError(key, versions[key], supported);
  }
}
