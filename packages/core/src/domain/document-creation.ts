/** Private permission for the fixed new-unsaved-document service. This is a
 * write to a new resource, never a read-only declaration or raw-script grant. */
export interface DocumentCreation {
  version: 1;
  requestHash: string;
  generation: string;
  rpcHash: string;
  /** Independently rendered canonical program, including its UUIDv4 UI guard.
   * Actual wire bytes have a separate hash and certificate at dispatch. */
  programHash: string;
}
export interface DocumentCreationAuthority {
  readonly __documentCreationAuthority: "private-document-creation";
}
const authorities = new WeakMap<DocumentCreationAuthority, { domain: object; verify: () => DocumentCreation }>();
export function validDocumentCreation(value: unknown): value is DocumentCreation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).sort().join() === "generation,programHash,requestHash,rpcHash,version" &&
    fields["version"] === 1 && typeof fields["generation"] === "string" &&
    !!fields["generation"].trim() && fields["generation"].length <= 256 &&
    ["requestHash", "rpcHash", "programHash"].every((key) =>
      typeof fields[key] === "string" && /^[a-f0-9]{64}$/.test(fields[key]));
}
function refuse(): never {
  throw Object.assign(new Error("A current private document creation capability is required"), { code: "DOCUMENT_CREATION_UNPROVEN" });
}
export function createDocumentCreationAuthority(domain: object, verify: () => DocumentCreation): DocumentCreationAuthority {
  if (typeof verify !== "function") refuse();
  const authority = Object.freeze({}) as DocumentCreationAuthority;
  authorities.set(authority, { domain, verify });
  return authority;
}
export function verifiedDocumentCreation(authority: DocumentCreationAuthority | undefined, domain: object): DocumentCreation {
  const entry = authority && authorities.get(authority);
  if (!entry || entry.domain !== domain) refuse();
  const value = entry.verify();
  if (!validDocumentCreation(value)) { void Promise.resolve(value).catch(() => {}); refuse(); }
  return Object.freeze({ ...value });
}
