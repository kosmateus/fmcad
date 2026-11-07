import type { ContractVersions } from "./contracts";

export const contractVersions: ContractVersions = Object.freeze({
  api: 1,
  dto: 1,
  broker: 2,
  persistedState: 1,
  pythonEnvelope: 1,
  controlApi: 1,
});

export class CompatibilityError extends Error {
  readonly code = "FMCAD_INCOMPATIBLE_CONTRACT";
  constructor(
    readonly boundary: string,
    readonly received: unknown,
    readonly supported: unknown,
  ) {
    super(
      `Unsupported fmcad ${boundary} contract; upgrade client and broker together before retrying`,
    );
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
