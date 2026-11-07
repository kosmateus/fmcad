/** Immutable caller input, excluding only fields authored by queue admission. */
export function requestIdentity(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const value: Record<string, unknown> = { ...request };
  for (const key of ["clientId", "ownerToken", "isolatedEpoch", "description"])
    delete value[key];
  if (value["kind"] === "command" && Array.isArray(value["argv"]))
    delete value["phased"];
  if (value["kind"] === "rpc") {
    const raw = value["rpc"];
    const rpc =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined;
    value["payload"] = rpc?.["payload"] || value["payload"];
    value["sessionId"] = rpc?.["sessionId"] ?? value["sessionId"];
    delete value["rpc"];
    if (value["sessionId"] === undefined) delete value["sessionId"];
  }
  return value;
}

interface AdmittedRequest {
  readonly id: string;
  readonly requestId: string;
  readonly clientId: string;
  readonly request: Record<string, unknown>;
}
/** Current namespace only; historical requests never become recovered admissions. */
export function matchAdmittedRequest(
  jobs: Readonly<Record<string, AdmittedRequest>>,
  clientId: string,
  requestId: string,
  expected: unknown,
  same: (left: unknown, right: unknown) => boolean,
): string | null {
  if (
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    !("requestId" in expected) ||
    expected.requestId !== requestId
  )
    throw Object.assign(
      new Error("Recovery lookup requires the exact submitted request"),
      { code: "INVALID_REQUEST" },
    );
  const original = Object.values(jobs).find(
    (job) => job.requestId === requestId && job.clientId === clientId,
  );
  if (!original) return null;
  if (
    !same(
      requestIdentity(original.request),
      requestIdentity(expected as Record<string, unknown>),
    )
  )
    throw Object.assign(
      new Error(
        "Original request has different immutable input; no admission response was recovered",
      ),
      { code: "REQUEST_CONFLICT" },
    );
  return original.id;
}
