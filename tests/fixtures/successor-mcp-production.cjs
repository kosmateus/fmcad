"use strict";

// Real broker/client/checker; only the loopback MCP peer and its SDK receipts
// are synthetic. This child owns every directory, socket and process it uses.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const repo = path.resolve(__dirname, "../..");
const root = process.argv[2];
const restorePlatform = require("./fake-wsl-platform.cjs")();
const api = require(repo + "/src/queue-instance");
const lineage = require(repo + "/src/queue-epoch-lineage");
const hash = require(repo + "/src/dist/core/application/cad/json").hash;
const { BrokerMcpClient } = require(repo + "/src/dist/fusion-transport/mcp");

async function main() {
  const f = require("./backend-successor.cjs")(root, repo);
  const foreignToken = "synthetic-foreign-token";
  api.durable(path.join(f.dir, "clients.json"), {
    ...api.readJson(path.join(f.dir, "clients.json")),
    "synthetic-foreign-owner": api.hash(foreignToken),
  });
  const inspected = require(
    repo + "/src/queue-epoch-successor",
  ).inspectSuccessor(f.client, f.cfg, f.approvalFile, f.requestId);
  const authority = {
    ...f.authority,
    configHash: api.brokerConfigHash(f.cfg),
    backendTransition: inspected.backendTransition,
  };
  if (process.argv[3] === "process-refusal")
    authority.expectedProcess = {
      pid: 2147483644,
      birth: "dead:changed-selected-process",
    };
  api.durable(f.authorityEntry.path, authority);
  const authorityEntry = lineage.reference(f.authorityEntry.path);
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
  });
  const guard = {
    kind: "dead-epoch-successor",
    nonce: authority.nonce,
    audit: f.audit,
    clientId: f.clientId,
  };
  for (const name of ["recovery.lock", "atomic-migration.lock"])
    api.durable(path.join(f.dir, name), guard, true);
  api.durable(path.join(f.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: authorityEntry,
  });
  fs.renameSync(
    path.join(f.dir, "broker.lock"),
    path.join(f.audit, "retired-owner.json"),
  );
  const predecessor = fs.readFileSync(authority.predecessor.state.path);
  const instance = {
    ...authority.expectedProcess,
    version: "synthetic-sdk",
    activeCommand: "SelectCommand",
  };
  const calls = [],
    checks = [],
    results = [];
  const persist = () =>
    fs.writeFileSync(
      path.join(root, "fixture-report.json"),
      JSON.stringify(
        {
          calls,
          checks,
          results,
          realSdkRequests: 0,
          boundary:
            "Real serve/McpClient/production checker, loopback fake peer and synthetic receipts; not native Fusion evidence",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  let endpointFailure;
  const endpoint = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        calls.push(payload.method);
        const answer = (result) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "offline-session",
          });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
        };
        if (payload.method === "initialize")
          return answer({ protocolVersion: "2024-11-05" });
        if (payload.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        assert.equal(payload.method, "tools/call");
        assert.equal(payload.params.name, "execute_python");
        assert.deepEqual(Object.keys(payload.params.arguments).sort(), [
          "code",
          "persistent",
        ]);
        assert.equal(payload.params.arguments.persistent, false);
        assert.match(payload.id, /^fmcad:[a-f0-9-]{36}$/);
        const directory = [
          "dead-epoch-current-observation",
          "isolated-scratch-qualification",
          "isolated-scratch-close",
        ]
          .map((name) => path.join(f.audit, name))
          .find(
            (dir) =>
              fs.existsSync(path.join(dir, "start.json")) &&
              !fs.existsSync(
                api.readJson(path.join(dir, "start.json")).receipt,
              ),
          );
        assert.ok(
          directory,
          "Actual broker must publish a start before the physical call",
        );
        const prior = api.readJson(path.join(directory, "intent.json"));
        const start = api.readJson(path.join(directory, "start.json"));
        assert.equal(start.binding.buildHash, authority.buildHash);
        assert.equal(payload.id, "fmcad:" + start.binding.rpcId);
        assert.equal(start.pythonCheck.status, "passed");
        assert.equal(start.pythonCheck.provenance.checker, "basedpyright");
        const wire = api.readJson(path.join(directory, "wire.json"));
        assert.equal(api.hash(payload.params.arguments.code), wire.artifact.sha256);
        assert.equal(wire.artifact.sha256, start.pythonCheck.provenance.wireHash);
        assert.equal(wire.artifact.artifactHash, start.pythonCheck.provenance.artifactHash);
        assert.deepEqual(wire.outgoing, payload);
        checks.push({
          kind: path.basename(directory),
          binding: start.binding,
          checker: start.pythonCheck,
          wireId: payload.id,
        });
        persist();
        const common = {
          historicalOutcome: "unknown",
          originalModelValidation: "not_performed",
          originalRollbackVerification: "not_performed",
        };
        let summary;
        if (path.basename(directory) === "dead-epoch-current-observation") {
          summary = {
            version: 1,
            purpose: "atomic-recovery-audit-v1",
            profile: "atomic-recovery-counts-v1",
            requestIdentity: f.auditIdentity,
            nativeOutcome: "unknown",
            modelValidation: "not_performed",
            rollbackVerification: "not_performed",
            modulePresent: false,
            ui: { activeCommand: "SelectCommand", idle: true },
            commandDefinition: { status: "absent" },
            document: { status: "absent", matches: 0 },
            snapshot: null,
            fingerprint: null,
          };
        } else if (
          path.basename(directory) === "isolated-scratch-qualification"
        ) {
          summary = {
            version: 1,
            purpose: "isolated-scratch-epoch-v1",
            epochId: prior.binding.epochId,
            bindingHash: hash(prior.binding),
            document: {
              name: "FMCAD_ISOLATED_" + prior.binding.epochId,
              creationId: "new-synthetic-mcp-document",
              fileId: null,
            },
            independent: true,
            empty: true,
            unsaved: true,
            activeCommand: "SelectCommand",
            beforeIdsHash: "c".repeat(64),
            previousActiveCreationId: "synthetic-original-active",
            ...common,
          };
          api.durable(prior.binding.sdkProofPath, summary, true);
        } else {
          summary = {
            version: 1,
            purpose: "isolated-scratch-close-v1",
            document: prior.binding.document,
            bindingHash: hash(prior.binding),
            closed: true,
            saved: false,
            activeBeforeCloseCreationId: prior.binding.document.creationId,
            restoredActiveCreationId: prior.binding.restoreActiveCreationId,
            activeDocumentRestored: true,
            ...common,
          };
          api.durable(prior.binding.sdkProofPath, summary, true);
        }
        api.durable(
          start.receipt,
          { ...start.binding, terminal: true, outcome: "succeeded", instance },
          true,
        );
        answer({
          content: [
            { type: "text", text: "FMCAD_RESULT " + JSON.stringify(summary) },
          ],
        });
      } catch (error) {
        endpointFailure = error;
        res.writeHead(500);
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const endpointUrl = `http://127.0.0.1:${endpoint.address().port}/mcp`;
  let factories = 0;
  const options = {
    dir: f.dir,
    confirmOwnership: true,
    autoReconcile: false,
    deadEpochSuccessorNonce: authority.nonce,
    nativePath: (file) => file,
    createBackend: (server) => {
      factories++;
      return new BrokerMcpClient(
        { ...server, url: endpointUrl, transport: "http" },
        {
          version: "offline-endpoint",
          requestTimeout: () => 30000,
          bridgeSource: () => "",
        },
      );
    },
  };
  if (process.argv[3] === "process-refusal") {
    await assert.rejects(
      require(repo + "/src/queue-broker").serve(f.cfg, options),
      { code: "EPOCH_SUCCESSOR_FENCE_CHANGED" },
    );
    assert.equal(factories, 0);
    assert.equal(calls.length, 0);
    console.log(
      "FULL_MCP_PROCESS_REFUSAL " +
        JSON.stringify({ passed: true, factories, requests: calls.length }),
    );
    endpoint.close();
    return;
  }
  const broker = await require(repo + "/src/queue-broker").serve(
    f.cfg,
    options,
  );
  // This is the authenticated bootstrap's metadata-only release, synthetic files only.
  for (const name of ["recovery.lock", "atomic-migration.lock"])
    fs.unlinkSync(path.join(f.dir, name));
  const request = require(repo + "/src/queue-connection").request;
  const call = (action, rest = {}, clientId = f.clientId) =>
    request(f.dir, {
      action,
      auth: { clientId, clientToken: f.token },
      ...rest,
    });
  async function control() {
    const status = await call("queue-summary");
    const { instanceId, generation, contextEpoch, buildHash } = status.control;
    return { instanceId, generation, contextEpoch, buildHash };
  }
  async function operation(action, suffix, extra = {}) {
    const message = {
      jobId: f.pointer.quarantinedJobIds[0],
      observationJobId: f.pointer.quarantinedJobIds[1],
      requestId: f.requestId + suffix,
      ...extra,
      control: await control(),
    };
    let value = await call(action, message);
    const deadline = Date.now() + 120000;
    while (value.status === "pending") {
      if (endpointFailure) throw endpointFailure;
      assert.ok(Date.now() < deadline, "Offline broker/checker must settle");
      await new Promise((resolve) => setTimeout(resolve, 25));
      value = await call(action, message);
    }
    results.push({ action, requestId: message.requestId, value });
    persist();
    assert.equal(value.status, "complete", JSON.stringify(value));
    return value;
  }
  try {
    assert.equal(
      calls.length,
      0,
      "Metadata-ready startup sends no MCP request",
    );
    const stale = { ...(await control()), buildHash: "0".repeat(64) };
    const message = {
      jobId: f.pointer.quarantinedJobIds[0],
      observationJobId: f.pointer.quarantinedJobIds[1],
      requestId: f.requestId + ":observe",
      control: await control(),
    };
    await assert.rejects(
      call("observe-successor", { ...message, control: stale }),
    );
    await assert.rejects(
      call("observe-successor", { ...message, script: "caller-supplied-code" }),
      { code: "INVALID_REQUEST" },
    );
    await assert.rejects(
      request(f.dir, {
        action: "observe-successor",
        ...message,
        auth: {
          clientId: "synthetic-foreign-owner",
          clientToken: foreignToken,
        },
      }),
      { code: "NOT_OWNER" },
    );
    assert.equal(calls.length, 0);
    const observed = await operation("observe-successor", ":observe");
    const created = await operation("create-isolated-scratch", ":create");
    const closed = await operation("close-isolated-scratch", ":close", {
      admissionMode: "normal-multidocument",
    });
    if (endpointFailure) throw endpointFailure;
    assert.deepEqual(
      checks.map((check) => check.kind),
      [
        "dead-epoch-current-observation",
        "isolated-scratch-qualification",
        "isolated-scratch-close",
      ],
    );
    for (const check of checks) {
      const response = api.readJson(path.join(f.audit, check.kind, "response.json"));
      assert.equal(response.callerId, 2);
      assert.equal(response.wireId, check.wireId);
      assert.equal(response.reply.id, check.wireId);
      assert.deepEqual(response.binding, check.binding);
    }
    assert.deepEqual(
      fs.readFileSync(authority.predecessor.state.path),
      predecessor,
    );
    const final = await call("queue-summary");
    assert.equal(final.admissionScope, "normal-multidocument");
    assert.equal(calls.filter((method) => method === "tools/call").length, 3);
    console.log(
      "FULL_MCP_PRODUCTION_CHECKER_RESULT " +
        JSON.stringify({
          passed: true,
          realSdkRequests: 0,
          syntheticToolCalls: 3,
          checks,
          metadataSdk0: true,
          historicalUnknownPreserved: true,
          observed,
          created,
          closed,
        }),
    );
  } finally {
    // No production process is involved; the test child exits below even when
    // the intentionally quarantined synthetic predecessor prevents close().
    endpoint.close();
    void broker;
  }
}
main()
  .then(() => {
    restorePlatform();
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    restorePlatform();
    process.exit(1);
  });
