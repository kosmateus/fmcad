const { acceptedWorkerRequest } = require(
  process.env.FMCAD_TEST_CONNECTION_MODULE,
);
const { flushDebugTrace } = require(process.env.FMCAD_TEST_DIAGNOSTIC_MODULE);

async function main() {
  const message = {
    action: "backend",
    jobId: process.env.FMCAD_TEST_JOB_ID,
    workerToken: process.env.FMCAD_TEST_WORKER_TOKEN,
    method: "callTool",
    args: [],
    rpcTimeoutMs: 1000,
  };
  const options = {
    pollMs: Number(process.env.FMCAD_TEST_POLL_MS),
    heartbeatTimeoutMs: Number(process.env.FMCAD_TEST_HEARTBEAT_TIMEOUT_MS),
    debugTrace: JSON.parse(process.env.FMCAD_TEST_TRACE_CONTEXT),
    buildHash: process.env.FMCAD_TEST_BUILD_HASH,
  };
  try {
    const result = await acceptedWorkerRequest(
      process.env.FMCAD_TEST_QUEUE_DIR,
      message,
      options,
    );
    await flushDebugTrace();
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    await flushDebugTrace();
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code: error && typeof error === "object" ? error.code : undefined,
      }),
    );
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exitCode = 1;
});
