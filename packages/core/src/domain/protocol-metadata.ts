/** A private capability for closed protocol metadata, not a caller's readonly
 * declaration or permission to run a tool. Historical outcomes remain unchanged. */
export interface ProtocolMetadata {
  readonly version: 1;
  readonly kind: "protocol-metadata";
  readonly requestHash: string;
  readonly rpcHash: string;
  readonly generation: string;
}
export interface ProtocolMetadataAuthority {
  readonly __protocolMetadataAuthority: "private-protocol-metadata";
}
const authorities = new WeakMap<
  ProtocolMetadataAuthority,
  { domain: object; verify: () => ProtocolMetadata }
>();
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function validProtocolMetadata(
  value: unknown,
): value is ProtocolMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).sort().join(",") ===
      "generation,kind,requestHash,rpcHash,version" &&
    fields["version"] === 1 &&
    fields["kind"] === "protocol-metadata" &&
    typeof fields["generation"] === "string" &&
    !!fields["generation"].trim() &&
    fields["generation"].length <= 256 &&
    digest(fields["requestHash"]) &&
    digest(fields["rpcHash"])
  );
}
function refuse(): never {
  throw Object.assign(
    new Error(
      "An exact current compiler-bound protocol metadata proof is required",
    ),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
}
export function createProtocolMetadataAuthority(
  domain: object,
  verify: () => ProtocolMetadata,
): ProtocolMetadataAuthority {
  if (typeof verify !== "function") refuse();
  const authority = Object.freeze({}) as ProtocolMetadataAuthority;
  authorities.set(authority, { domain, verify });
  return authority;
}
export function verifiedProtocolMetadata(
  authority: ProtocolMetadataAuthority | undefined,
  domain: object,
): ProtocolMetadata {
  const entry = authority && authorities.get(authority);
  if (!entry || entry.domain !== domain) refuse();
  const value = entry.verify();
  if (!validProtocolMetadata(value)) {
    void Promise.resolve(value).catch(() => {});
    refuse();
  }
  // Every check calls the live verifier, then isolates the returned witness.
  return Object.freeze({
    version: 1,
    kind: "protocol-metadata",
    requestHash: value.requestHash,
    rpcHash: value.rpcHash,
    generation: value.generation,
  });
}
