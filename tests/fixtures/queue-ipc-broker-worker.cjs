const fs = require("node:fs");
const path = require("node:path");

const { acceptedWorkerRequest } = require(
  process.env.FMCAD_TEST_CONNECTION_MODULE,
);
const { flushDebugTrace } = require(process.env.FMCAD_TEST_DIAGNOSTIC_MODULE);

async function main() {
  const file = process.env.FMCAD_TEST_WORKER_REQUEST_FILE;
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  await acceptedWorkerRequest(
    process.env.FMCAD_QUEUE_DIR,
    {
      action: "backend",
      jobId: job.id,
      workerToken: process.env.FMCAD_QUEUE_WORKER_TOKEN,
      method: "listTools",
      args: [],
      rpcTimeoutMs: 1000,
    },
    {
      pollMs: 10,
      debugTrace: job.request.debugTrace,
      buildHash: job.buildHash,
    },
  );
  await flushDebugTrace();
  fs.writeFileSync(
    path.join(path.dirname(file), "worker-result.json"),
    JSON.stringify({ jobId: job.id, code: 0, terminal: true }),
    { mode: 0o600 },
  );
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exitCode = 1;
});
