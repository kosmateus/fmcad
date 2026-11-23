import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  queueExecReceipt,
  queueExecReceiptWithDiagnostics,
} from "./queue-backend";

const owner = { clientId: "scenario:owned-client" };

test("missing public job receipt retains exact CLI output in a private request artifact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = {
    status: 1,
    stdout: "original stdout\n",
    stderr:
      'FMCAD_QUEUE_REQUEST {"requestId":"request:original","clientId":"scenario:owned-client"}\noriginal stderr\n',
  };

  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        result,
        directory: root,
        cliPath: "/qualified/bin/fmcad.js",
        argv: ["run", "owned-script.py"],
        owner,
        requestId: "request:original",
      }),
    (error: Error & { diagnosticPath?: string }) => {
      assert.match(error.message, /job receipt is missing or mismatched/);
      assert.ok(error.diagnosticPath);
      const artifact = JSON.parse(
        fs.readFileSync(error.diagnosticPath, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(artifact["requestId"], "request:original");
      assert.equal(artifact["clientId"], owner.clientId);
      assert.equal(artifact["stdout"], result.stdout);
      assert.equal(artifact["stderr"], result.stderr);
      assert.equal(typeof artifact["scriptIdentity"], "string");
      assert.equal(fs.statSync(error.diagnosticPath).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.dirname(error.diagnosticPath)).mode & 0o777,
        0o700,
      );
      return true;
    },
  );
});

test("receipt success and identity failures keep their existing validation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = {
    status: 0,
    stdout: "ok\n",
    stderr: [
      `FMCAD_QUEUE_REQUEST ${JSON.stringify({ requestId: "request:ok", clientId: owner.clientId })}`,
      `FMCAD_QUEUE_JOB ${JSON.stringify({ jobId: "job-1", requestId: "request:ok" })}`,
    ].join("\n"),
  };
  assert.deepEqual(
    queueExecReceiptWithDiagnostics({
      result,
      directory: root,
      cliPath: "/qualified/bin/fmcad.js",
      argv: ["run", "owned-script.py"],
      owner,
      requestId: "request:ok",
    }),
    { jobId: "job-1" },
  );
  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        result: {
          ...result,
          stderr: result.stderr.replace("request:ok", "foreign"),
        },
        directory: root,
        cliPath: "/qualified/bin/fmcad.js",
        argv: ["run", "owned-script.py"],
        owner,
        requestId: "request:ok",
      }),
    /request receipt has a foreign identity/,
  );
  assert.throws(
    () => queueExecReceipt(result.stderr, owner, "request:other"),
    /request receipt has a foreign identity/,
  );
});

test("diagnostic write failure does not replace the primary receipt failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-cli-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(os.tmpdir(), path.join(root, "queue-exec-diagnostics"));
  assert.throws(
    () =>
      queueExecReceiptWithDiagnostics({
        result: { status: 1, stdout: "", stderr: "" },
        directory: root,
        cliPath: "/qualified/bin/fmcad.js",
        argv: ["run", "owned-script.py"],
        owner,
        requestId: "request:missing",
      }),
    (error: Error & { diagnosticPath?: string }) => {
      assert.match(error.message, /request receipt has a foreign identity/);
      assert.equal(error.diagnosticPath, undefined);
      return true;
    },
  );
});
