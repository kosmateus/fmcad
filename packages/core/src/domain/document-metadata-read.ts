/** Private compiler proof for one metadata read. It is not a caller read-only
 * declaration and does not settle a historical document outcome. */
export interface DocumentMetadataRead {
  version: 1;
  requestHash: string;
  generation: string;
  rpcHash: string;
  /** Stable compiler program before the independently checked receipt wrapper. */
  programHash: string;
}
export interface DocumentMetadataReadAuthority {
  readonly __documentMetadataReadAuthority: "private-document-metadata-read";
}
const authorities = new WeakMap<
  DocumentMetadataReadAuthority,
  { domain: object; verify: () => DocumentMetadataRead }
>();
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validDocumentMetadataRead(value: unknown): value is DocumentMetadataRead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).sort().join(",") ===
    "generation,programHash,requestHash,rpcHash,version" &&
    fields["version"] === 1 &&
    typeof fields["generation"] === "string" &&
    !!fields["generation"].trim() && fields["generation"].length <= 256 &&
    digest(fields["requestHash"]) && digest(fields["rpcHash"]) && digest(fields["programHash"]);
}
function refused(): never {
  throw Object.assign(
    new Error("An exact current compiler-bound metadata read is required"),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" },
  );
}
export function createDocumentMetadataReadAuthority(
  domain: object,
  verify: () => DocumentMetadataRead,
): DocumentMetadataReadAuthority {
  if (typeof verify !== "function") refused();
  const capability = Object.freeze({}) as DocumentMetadataReadAuthority;
  authorities.set(capability, { domain, verify });
  return capability;
}
export function verifiedDocumentMetadataRead(
  authority: DocumentMetadataReadAuthority | undefined,
  domain: object,
): DocumentMetadataRead {
  const entry = authority && authorities.get(authority);
  if (!entry || entry.domain !== domain) refused();
  const value = entry.verify();
  if (!validDocumentMetadataRead(value)) {
    void Promise.resolve(value).catch(() => {});
    refused();
  }
  // Never retain the callback's mutable object as the verified witness.
  return Object.freeze({
    version: 1, requestHash: value.requestHash, generation: value.generation,
    rpcHash: value.rpcHash, programHash: value.programHash,
  });
}
