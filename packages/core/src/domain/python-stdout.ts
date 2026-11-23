/** Compiler-owned permission for the bounded stdout profile. An AST result,
 * a caller flag, or a serialized marker alone never grants this capability. */
export interface PythonStdout {
  readonly version: 1;
  readonly kind: "python-stdout";
  readonly engineVersion: "python-source-effects-v2";
  readonly profileVersion: "isolated-stdout-v1";
  readonly requestHash: string;
  readonly rpcHash: string;
  readonly sourceHash: string;
  readonly programHash: string;
  readonly hostBindingHash: string;
  readonly generation: string;
}
export interface PythonStdoutAuthority {
  readonly __pythonStdoutAuthority: "private-python-stdout";
}
const authorities = new WeakMap<
  PythonStdoutAuthority,
  { domain: object; verify: () => PythonStdout }
>();
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(): never {
  throw Object.assign(
    new Error("Current compiler and host stdout proof required"),
    {
      code: "PYTHON_STDOUT_UNPROVEN",
    },
  );
}
export function validPythonStdout(value: unknown): value is PythonStdout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).sort().join() ===
      "engineVersion,generation,hostBindingHash,kind,profileVersion,programHash,requestHash,rpcHash,sourceHash,version" &&
    fields["version"] === 1 &&
    fields["kind"] === "python-stdout" &&
    fields["engineVersion"] === "python-source-effects-v2" &&
    fields["profileVersion"] === "isolated-stdout-v1" &&
    [
      "requestHash",
      "rpcHash",
      "sourceHash",
      "programHash",
      "hostBindingHash",
    ].every((key) => digest(fields[key])) &&
    typeof fields["generation"] === "string" &&
    !!fields["generation"].trim() &&
    fields["generation"].length <= 256
  );
}
export function createPythonStdoutAuthority(
  domain: object,
  verify: () => PythonStdout,
): PythonStdoutAuthority {
  if (typeof verify !== "function") refuse();
  const authority = Object.freeze({}) as PythonStdoutAuthority;
  authorities.set(authority, { domain, verify });
  return authority;
}
export function verifiedPythonStdout(
  authority: PythonStdoutAuthority | undefined,
  domain: object,
): PythonStdout {
  const entry = authority && authorities.get(authority);
  if (!entry || entry.domain !== domain) refuse();
  const value = entry.verify();
  if (!validPythonStdout(value)) {
    void Promise.resolve(value).catch(() => {});
    refuse();
  }
  // Re-run the live host/compiler verifier on every use; never store its answer.
  return Object.freeze({ ...value });
}
