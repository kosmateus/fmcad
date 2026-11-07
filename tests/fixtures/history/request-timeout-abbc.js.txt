const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

function requestTimeout(server, env = process.env) {
  const timeout = server.timeoutMs;
  // Admission control, not cancellation: refuse the NEXT RPC if its full
  // allowance no longer fits. This also bounds initialization and all steps
  // of a multi-request batch.
  const outer = env.FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS;
  if (outer !== undefined) {
    const remaining = Number(outer) - monotonicMs();
    if (!Number.isFinite(remaining) || !(timeout > 0) || timeout > remaining) {
      const error = new Error('RPC not submitted: insufficient fmcad_execute budget for its full timeout. Earlier calls may have run; inspect reports, split the remaining work, never replay uncertain mutations.');
      error.code = 'FMCAD_RPC_NOT_SUBMITTED_BUDGET';
      throw error;
    }
  }
  return timeout;
}

module.exports = { requestTimeout, monotonicMs };
