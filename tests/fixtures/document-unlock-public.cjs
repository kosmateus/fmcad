"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const { once } = require("node:events");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createHash, randomUUID } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const runId = randomUUID();
const documentIds = {
  documentA: `fixture-document-A-${runId}`,
  fileA: `fixture-file-A-${runId}`,
  documentB: `fixture-document-B-${runId}`,
  fileB: `fixture-file-B-${runId}`,
};
const offlineDocumentHistories = new Map();
const offlineBrokerReferences = new Map();
const activePublicMcpClients = new Set();
const clientCloseTimeoutMs = 5000;
const config = {
  backend: "addin",
  routing: "queue",
  backends: {
    addin: {
      url: "http://127.0.0.1:8765/mcp",
      headers: {},
      timeoutMs: 120000,
      tool: "execute_python",
      transport: "node",
      protocolVersion: "2025-06-18",
    },
  },
  queue: { autoStart: false, autoRecover: false },
  controlCenter: { port: 4748 },
};

function preparePublicEnvironment(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configFile = path.join(directory, "config.json");
  if (!fs.existsSync(configFile))
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const preload = path.join(directory, "disable-control-center.cjs");
  fs.writeFileSync(
    preload,
    `
      const Module = require("node:module");
      const load = Module._load;
      Module._load = function (request, ...args) {
        if (request === "../composition/control-center.js")
          return { ensureControlCenter: async () => {} };
        return load.call(this, request, ...args);
      };
    `,
    { mode: 0o600 },
  );
  return {
    configFile,
    environment: {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      XDG_STATE_HOME: directory,
      FMCAD_CONFIG: configFile,
      FMCAD_BACKEND: "addin",
      FMCAD_ROUTING: "queue",
      FMCAD_PROJECT_DIRECTORY: directory,
    },
    preload,
  };
}

async function waitForProcessClose(closed, timeoutMs, description) {
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort;
  const timeout = new Promise((_, reject) => {
    onAbort = () =>
      reject(new Error(`${description} did not exit within ${timeoutMs}ms`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([closed, timeout]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function startPublicMcp({ directory, clientId, projectDirectory = directory }) {
  const prepared = preparePublicEnvironment(directory);
  const child = spawn(
    process.execPath,
    [
      "--require",
      prepared.preload,
      path.join(root, "bin/fmcad-mcp.js"),
      "--client",
      clientId,
      "--project-directory",
      projectDirectory,
    ],
    {
      cwd: root,
      env: prepared.environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  const lines = readline
    .createInterface({ input: child.stdout })
    [Symbol.asyncIterator]();
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  let sequence = 0;
  async function request(message) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`MCP process exited before request: ${diagnostics}`);
    child.stdin.write(JSON.stringify(message) + "\n");
    const line = await lines.next();
    if (line.done)
      throw new Error(`MCP process closed before response: ${diagnostics}`);
    const response = JSON.parse(line.value);
    if (response.error)
      throw Object.assign(new Error(response.error.message), {
        code: response.error.code,
      });
    return response.result;
  }
  const client = {
    directory: path.resolve(directory),
    child,
    diagnostics: () => diagnostics,
    closed,
    async initialize() {
      return request({
        jsonrpc: "2.0",
        id: ++sequence,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: clientId, version: "test" },
        },
      });
    },
    notifyInitialized() {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
    },
    async tools() {
      return request({
        jsonrpc: "2.0",
        id: ++sequence,
        method: "tools/list",
        params: {},
      });
    },
    callTool(name, args, fmcad) {
      return request({
        jsonrpc: "2.0",
        id: ++sequence,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          ...(fmcad ? { _meta: { fmcad } } : {}),
        },
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.stdin.end();
      const [code, signal] = await waitForProcessClose(
        closed,
        clientCloseTimeoutMs,
        `MCP client ${clientId}`,
      );
      if (code !== 0 || signal !== null)
        throw new Error(`MCP process exited ${code ?? signal}: ${diagnostics}`);
    },
    async kill(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
      await waitForProcessClose(
        closed,
        clientCloseTimeoutMs,
        `MCP client ${clientId} after ${signal}`,
      );
    },
  };
  activePublicMcpClients.add(client);
  closed.then(
    () => activePublicMcpClients.delete(client),
    () => activePublicMcpClients.delete(client),
  );
  return client;
}

async function closePublicMcpClients(directory) {
  const failures = [];
  for (const client of [...activePublicMcpClients]) {
    if (client.directory !== path.resolve(directory)) continue;
    try {
      await client.close();
    } catch (error) {
      failures.push(error);
      try {
        await client.kill("SIGTERM");
      } catch (terminationError) {
        failures.push(terminationError);
      }
    }
  }
  return failures;
}

function runPublicCli({ directory, clientId, args, timeout = 30000 }) {
  const prepared = preparePublicEnvironment(directory);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "bin/fmcad.js"), ...args],
      {
        cwd: root,
        env: {
          ...prepared.environment,
          FMCAD_CLIENT: clientId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeRequest(script) {
  const { decodeNativeProgram } = require("./native-source-envelope.cjs");
  let source = script;
  for (let depth = 0; depth < 8; depth++) {
    source = decodeNativeProgram(source);
    const match = /_FMCAD_REQUEST:\s*"_FMCADRequest"\s*=\s*(\{[^\r\n]*\})/.exec(
      source,
    );
    if (match) {
      const decoded = spawnSync(
        "python3",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          "import ast,json,sys; print(json.dumps(ast.literal_eval(sys.stdin.read())))",
        ],
        { input: match[1], encoding: "utf8" },
      );
      if (decoded.status !== 0)
        throw new Error(
          decoded.stderr || "Could not decode the compiled CAD request",
        );
      return JSON.parse(decoded.stdout);
    }
    const wrapped = source.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
    if (!wrapped) return null;
    source = JSON.parse(wrapped[1]);
  }
  throw new Error("The compiled CAD request is nested too deeply");
}

function startOfflineBroker(
  t,
  { home = fs.mkdtempSync("/tmp/opencode/document-unlock-public-") } = {},
) {
  // The broker is fixture setup only. All scenario actions use separately
  // spawned public fmcad MCP stdio or CLI processes.
  const prepared = preparePublicEnvironment(home);
  const environmentKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "FMCAD_CONFIG",
    "FMCAD_BACKEND",
    "FMCAD_ROUTING",
    "FMCAD_PROJECT_DIRECTORY",
  ];
  const previousEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  const oldCwd = process.cwd();
  const homeState = offlineBrokerReferences.get(home) ?? {
    references: 0,
    originalEnvironment: previousEnvironment,
    originalCwd: oldCwd,
  };
  homeState.references++;
  offlineBrokerReferences.set(home, homeState);
  for (const key of environmentKeys) {
    const value = prepared.environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(home);

  const load = (name) => require(path.join(root, "dist/src", name));
  const { createBrokerTransport } = load("dist/fusion-transport/broker");
  const { serve } = load("queue-broker");
  const { queueDirectory } = load("queue-connection");
  const { loadConfig } = load("config");
  const { nativeReceipts } = require("./native-source-envelope.cjs");
  const releasedProof = require("./physical-turn-fixture.cjs");
  const { cfg } = loadConfig({});
  const dir = queueDirectory();
  const physicalScope = new AsyncLocalStorage();
  const sentTurns = new Set();
  const calls = [];
  const operations = [];
  const documents = offlineDocumentHistories.get(home) ?? new Map();
  offlineDocumentHistories.set(home, documents);
  const documentIdentities = new Map([
    [
      documentIds.documentA,
      {
        name: "Offline document A",
        creationId: documentIds.documentA,
        fileId: documentIds.fileA,
        version: 1,
        isSaved: true,
        isModified: false,
      },
    ],
    [
      documentIds.documentB,
      {
        name: "Offline document B",
        creationId: documentIds.documentB,
        fileId: documentIds.fileB,
        version: 1,
        isSaved: true,
        isModified: false,
      },
    ],
  ]);
  const instance = {
    pid: 991,
    birth: "synthetic:991",
    version: "fixture",
    activeCommand: "SelectCommand",
    documents: [],
  };
  let nextHold;
  let broker;
  let closed = false;
  function identityFor(request) {
    const identity =
      [...documentIdentities.values()].find(
        (item) =>
          (request.docId && item.creationId === request.docId) ||
          (request.docFileId && item.fileId === request.docFileId) ||
          (request.doc && item.name === request.doc),
      ) ?? documentIdentities.values().next().value;
    assert(identity, "the offline fixture must have a known exact document");
    return identity;
  }
  function documentCheckpoint(identity) {
    const history = documents.get(identity.creationId) ?? new Map();
    const parameters = [...history.values()];
    const documentIdentity = {
      ...identity,
      isModified: parameters.length > 0,
    };
    return {
      schema: "fmcad.param-checkpoint-v1",
      document: {
        identity: documentIdentity,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(parameters))
          .digest("hex"),
      },
      parameters,
    };
  }
  const physical = createBrokerTransport(cfg, {
    version: "test",
    requestTimeout: (settings) => settings.timeoutMs,
    bridgeSource: () => {
      throw new Error("The offline fixture does not use an add-in bridge");
    },
  });
  physical._post = async (payload) => {
    calls.push(payload);
    if (payload.method === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: payload.params.protocolVersion },
        }),
      };
    if (payload.method === "notifications/initialized")
      return { status: 202, raw: "" };

    const binding = physicalScope.getStore();
    if (payload.method === "tools/call") {
      assert(binding, "every fake SDK call must be scoped to a physical turn");
      assert(
        !sentTurns.has(binding.turnId),
        "physical turn IDs are single-use",
      );
      sentTurns.add(binding.turnId);
    }

    const script =
      payload.params?.arguments?.object?.script ||
      payload.params?.arguments?.code;
    let stdout = "{}";
    if (typeof script === "string") {
      const request = nativeRequest(script);
      const identity = request
        ? identityFor(request)
        : documentIdentities.values().next().value;
      assert(identity, "the offline fixture must have a known exact document");
      const checkpoint = documentCheckpoint(identity);
      const observation = {
        ...instance,
        documentState: {
          status: "complete",
          fingerprint: checkpoint.document.fingerprint,
          state: {
            identity: checkpoint.document.identity,
            references: [],
          },
        },
      };
      const receipts = nativeReceipts(script, home, observation);
      const probe = receipts.some((receipt) => receipt.value.probeObservation);
      if (probe) {
        for (const receipt of receipts)
          fs.writeFileSync(receipt.file, JSON.stringify(receipt.value), {
            mode: 0o600,
          });
        stdout = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observation);
      } else {
        if (request) {
          const docKey = identity.creationId;
          const history = documents.get(docKey) ?? new Map();
          documents.set(docKey, history);
          const event = {
            operation: request.operation,
            docId: identity.creationId,
            docFileId: request.docFileId,
            creationId: identity.creationId,
            request,
            dispatch: calls.filter(
              (call) => call.method === "tools/call" && call.params?.arguments,
            ).length,
          };
          operations.push(event);

          const hold = nextHold;
          if (hold && request.operation === hold.operation) {
            nextHold = undefined;
            hold.started.resolve(event);
            await hold.release.promise;
          }

          let result = {};
          if (request.operation === "param.apply") {
            for (const parameter of request.data.parameters) {
              history.set(parameter.name, {
                name: parameter.name,
                expression: parameter.expression,
                unit: parameter.unit,
                value: Number.parseFloat(parameter.expression),
                valueType: "numeric",
                valueUnits: "Fusion internal units (cm, rad, kg, s)",
                comment: parameter.comment ?? "",
                metadata: parameter.metadata ?? {},
              });
            }
            result = {
              parameters: request.data.parameters.map((parameter) =>
                history.get(parameter.name),
              ),
              prevalidated: true,
              atomic: false,
            };
          } else if (request.operation === "document.status") {
            result = {
              ...identity,
              saved: true,
              modified: history.size > 0,
              version: 1,
              isComplete: true,
              isReadOnly: false,
            };
          } else if (request.operation === "param.inspect") {
            result = documentCheckpoint(identity);
          } else {
            result = { fixture: true };
          }

          for (const receipt of receipts)
            fs.writeFileSync(receipt.file, JSON.stringify(receipt.value), {
              mode: 0o600,
            });
          stdout =
            "FMCAD_RESULT " +
            JSON.stringify({
              success: true,
              operation: request.operation,
              document: request.doc ?? docKey,
              result,
              created: [],
            });
          if (hold) {
            hold.completed.resolve(event);
            if (hold.loseAcknowledgement)
              throw Object.assign(
                new Error(
                  "Synthetic lost SDK acknowledgement after handler completion",
                ),
                { code: "ECONNRESET" },
              );
          }
        } else
          for (const receipt of receipts)
            fs.writeFileSync(receipt.file, JSON.stringify(receipt.value), {
              mode: 0o600,
            });
      }
    }

    const execution = { success: true, stdout, stderr: "" };
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(execution) }],
        },
      }),
    };
  };

  const bindPhysicalTurn = (request) => ({
    version: 1,
    grantDigest: "a".repeat(64),
    generation: { instance: "fixture", epoch: "one" },
    physicalRuntime: {
      pid: 991,
      birth: "synthetic:991",
      version: "fixture",
      source: "fixture",
      build: "fixture",
    },
    turnId: request.physicalRequestId,
    target: JSON.stringify(
      request.documentSelector ?? null,
      Object.keys(request.documentSelector ?? {}).sort(),
    ),
  });
  const withPhysicalTurn = (binding, send) => physicalScope.run(binding, send);
  const physicalTurnQuiescence = async (binding) => releasedProof(binding);

  const ready = (async () => {
    broker = await serve(cfg, {
      dir,
      confirmOwnership: true,
      pollMs: 5,
      createBackend: () => physical,
      bindPhysicalTurn,
      withPhysicalTurn,
      physicalTurnQuiescence,
      nativePath: (value) => value,
    });
  })();

  t.after(async () => {
    const cleanupFailures = await closePublicMcpClients(home);
    try {
      await ready;
      if (!closed) {
        await broker.close();
        closed = true;
      }
    } catch (error) {
      cleanupFailures.push(error);
    } finally {
      const references = homeState.references - 1;
      if (references === 0) {
        offlineBrokerReferences.delete(home);
        process.chdir(homeState.originalCwd);
        for (const key of environmentKeys) {
          const value = homeState.originalEnvironment.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(home, { recursive: true, force: true });
        offlineDocumentHistories.delete(home);
      } else homeState.references = references;
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        cleanupFailures,
        "Offline broker fixture cleanup did not complete cleanly",
      );
  });

  return {
    home,
    configFile: prepared.configFile,
    dir,
    calls,
    operations,
    async ready() {
      await ready;
    },
    holdNextSdkOperation({
      operation = "param.apply",
      loseAcknowledgement = false,
    } = {}) {
      if (nextHold) throw new Error("A fake SDK operation is already held");
      const started = deferred();
      const release = deferred();
      const completed = deferred();
      nextHold = {
        started,
        release,
        completed,
        operation,
        loseAcknowledgement,
      };
      return {
        started: started.promise,
        completed: completed.promise,
        release: () => release.resolve(),
      };
    },
    dispatchCount(operation, docId) {
      return operations.filter(
        (entry) =>
          entry.operation === operation &&
          (docId === undefined ||
            entry.docId === docId ||
            entry.creationId === docId ||
            entry.docFileId === docId),
      ).length;
    },
    documentCheckpointState() {
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
      );
      return (
        state.documentCheckpoints ?? {
          observations: {},
          acceptances: {},
          heads: {},
        }
      );
    },
    jobSummaries() {
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
      );
      return Object.values(state.jobs).map((job) => ({
        id: job.id,
        requestId: job.requestId,
        clientId: job.clientId,
        kind: job.kind,
        state: job.state,
        code: job.code,
        request: job.request,
        details: job.details,
        physicalDispatches: job.physicalDispatches,
        documentInspection: job.documentInspection,
      }));
    },
    waitForJobTerminal(requestId, timeout = 45_000) {
      const stateFile = path.join(dir, "queue-state.json");
      const terminal = new Set([
        "succeeded",
        "failed",
        "cancelled",
        "expired",
        "needs_reconciliation",
      ]);
      const until = Date.now() + timeout;
      return new Promise((resolve, reject) => {
        const inspect = () => {
          try {
            const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            const job = Object.values(state.jobs).find(
              (candidate) => candidate.requestId === requestId,
            );
            if (job && terminal.has(job.state)) {
              resolve(job);
              return;
            }
          } catch (error) {
            if (error.code !== "ENOENT") {
              reject(error);
              return;
            }
          }
          if (Date.now() >= until) {
            reject(
              new Error(`Request ${requestId} did not reach a terminal state`),
            );
            return;
          }
          setTimeout(inspect, 10);
        };
        inspect();
      });
    },
    waitForUnknown(requestId, timeout = 5000) {
      const stateFile = path.join(dir, "queue-state.json");
      const until = Date.now() + timeout;
      return new Promise((resolve, reject) => {
        const inspect = () => {
          try {
            const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            const job = Object.values(state.jobs).find(
              (candidate) => candidate.requestId === requestId,
            );
            if (job?.state === "needs_reconciliation") {
              resolve(job);
              return;
            }
          } catch (error) {
            if (error.code !== "ENOENT") {
              reject(error);
              return;
            }
          }
          if (Date.now() >= until) {
            reject(new Error(`UNKNOWN request ${requestId} was not recorded`));
            return;
          }
          setTimeout(inspect, 10);
        };
        inspect();
      });
    },
    originalJob(requestId) {
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
      );
      return Object.values(state.jobs).find(
        (candidate) => candidate.requestId === requestId,
      );
    },
    jobOutcome(requestId) {
      const job = this.originalJob(requestId);
      if (!job?.id) return null;
      const file = path.join(dir, "jobs", job.id, "outcome.json");
      return fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : null;
    },
    originalIntentHashes(requestId) {
      const job = this.originalJob(requestId);
      const jobDirectory = path.join(dir, "jobs", job.id);
      const references = (job.physicalDispatches ?? [])
        .map((dispatch) => dispatch.intentReference)
        .filter((reference) => typeof reference === "string");
      return Object.fromEntries(
        references.map((reference) => [
          reference,
          createHash("sha256")
            .update(fs.readFileSync(path.join(jobDirectory, reference)))
            .digest("hex"),
        ]),
      );
    },
    async close() {
      const cleanupFailures = await closePublicMcpClients(home);
      await ready;
      if (!closed) {
        await broker.close();
        closed = true;
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          cleanupFailures,
          "Offline broker clients did not close cleanly",
        );
    },
  };
}

module.exports = {
  preparePublicEnvironment,
  root,
  runId,
  documentIds,
  runPublicCli,
  startOfflineBroker,
  startPublicMcp,
};
