export const monotonicMs = (): number => Number(process.hrtime.bigint()) / 1e6;
type Environment = Readonly<Record<string, string | undefined>>;

export function requestTimeout(
  server: { timeoutMs: number },
  env?: Environment,
): number;
export function requestTimeout(
  server: { timeoutMs?: number },
  env?: Environment,
): number | undefined;
export function requestTimeout(
  server: { timeoutMs?: number },
  env: Environment = process.env,
): number | undefined {
  const timeout = server.timeoutMs;
  // Refuse the next RPC when its full allowance no longer fits. This never
  // cancels or grants permission to replay an earlier physical request.
  const outer = env["FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS"];
  if (outer !== undefined) {
    const remaining = Number(outer) - monotonicMs();
    if (
      !Number.isFinite(remaining) ||
      timeout === undefined ||
      !(timeout > 0) ||
      timeout > remaining
    )
      throw Object.assign(
        new Error(
          "RPC not submitted: insufficient fmcad_execute budget for its full timeout. Earlier calls may have run; inspect reports, split the remaining work, never replay uncertain mutations.",
        ),
        { code: "FMCAD_RPC_NOT_SUBMITTED_BUDGET" },
      );
  }
  return timeout;
}
