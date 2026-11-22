import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const load = createRequire(
  path.join(process.cwd(), "tests/document-unlock-public.test.ts"),
);
const fixture = load("./fixtures/document-unlock-public.cjs") as {
  runId: string;
  documentIds: {
    documentA: string;
    fileA: string;
    documentB: string;
    fileB: string;
  };
  preparePublicEnvironment(directory: string): {
    configFile: string;
    environment: NodeJS.ProcessEnv;
    preload: string;
  };
  runPublicCli(input: {
    directory: string;
    clientId: string;
    args: string[];
  }): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  startPublicMcp(input: {
    directory: string;
    clientId: string;
    projectDirectory?: string;
  }): {
    initialize(): Promise<unknown>;
    notifyInitialized(): void;
    tools(): Promise<{ tools: unknown[] }>;
    callTool(
      name: string,
      args: Record<string, unknown>,
      fmcad?: Record<string, unknown>,
    ): Promise<unknown>;
    diagnostics(): string;
    close(): Promise<void>;
    kill(signal?: NodeJS.Signals): Promise<void>;
  };
  startOfflineBroker(
    t: TestContext,
    options?: { home?: string },
  ): {
    home: string;
    dir: string;
    calls: unknown[];
    operations: Array<Record<string, unknown>>;
    ready(): Promise<void>;
    holdNextSdkOperation(options?: {
      operation?: string;
      loseAcknowledgement?: boolean;
    }): {
      started: Promise<{
        operation: string;
        docId?: string;
        request: Record<string, unknown>;
      }>;
      completed: Promise<unknown>;
      release(): void;
    };
    dispatchCount(operation: string, docId?: string): number;
    documentCheckpointState(): {
      observations: Record<string, Record<string, unknown>>;
      acceptances: Record<string, Record<string, unknown>>;
      heads: Record<string, string>;
    };
    jobSummaries(): Array<Record<string, unknown>>;
    jobOutcome(requestId: string): Record<string, unknown> | null;
    waitForJobTerminal(
      requestId: string,
      timeoutMs?: number,
    ): Promise<Record<string, unknown>>;
    waitForUnknown(requestId: string): Promise<Record<string, unknown>>;
    originalJob(requestId: string): Record<string, unknown>;
    originalIntentHashes(requestId: string): Record<string, string>;
    close(): Promise<void>;
  };
};

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function resultContent(value: unknown): Record<string, unknown> {
  return object(object(value)["structuredContent"]);
}

function publicErrorCode(value: unknown): unknown {
  return object(resultContent(value)["error"])["code"];
}

function cliOutput(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): Record<string, unknown> {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return object(JSON.parse(result.stdout.trim()));
}

const { documentA, fileA, documentB, fileB } = fixture.documentIds;
const requestId = (name: string) => `${fixture.runId}-${name}`;
const unknownRequestId = requestId("unknown-a");

function unlockCliArgs(input: {
  action: "status" | "inspect" | "accept";
  target: { docId?: string; docFileId?: string };
  requestId?: string;
  observationId?: string;
}): string[] {
  return [
    "queue",
    "document-unlock",
    "--action",
    input.action,
    ...(input.target.docId === undefined
      ? []
      : [`--doc-id=${input.target.docId}`]),
    ...(input.target.docFileId === undefined
      ? []
      : [`--doc-file-id=${input.target.docFileId}`]),
    ...(input.requestId === undefined ? [] : ["--request-id", input.requestId]),
    ...(input.observationId === undefined
      ? []
      : ["--observation-id", input.observationId]),
  ];
}

function applyArguments(docId: string, expression: string) {
  return {
    operation: "param.apply",
    data: {
      parameters: [{ name: "unlock_width", expression, unit: "mm" }],
    },
    context: {
      doc: docId === documentA ? "Offline document A" : "Offline document B",
      docId,
      docFileId: docId === documentA ? fileA : fileB,
    },
  };
}

function assertMcpSuccess(value: unknown): Record<string, unknown> {
  assert.notEqual(object(value)["isError"], true, JSON.stringify(value));
  return resultContent(value);
}

function assertMcpFailure(value: unknown, code: string): void {
  assert.equal(object(value)["isError"], true, JSON.stringify(value));
  assert.equal(publicErrorCode(value), code, JSON.stringify(value));
}

type PublicMcpClient = ReturnType<typeof fixture.startPublicMcp>;

async function waitForPublicJob(
  client: PublicMcpClient,
  accepted: unknown,
  requestId: string,
): Promise<unknown> {
  const jobId = resultContent(accepted)["jobId"];
  assert.equal(typeof jobId, "string", JSON.stringify(accepted));
  const terminal = new Set([
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "needs_reconciliation",
  ]);
  const deadline = Date.now() + 90_000;
  let result: unknown;
  while (Date.now() < deadline) {
    result = await client.callTool("fmcad_queue_result", {
      jobId: String(jobId),
    });
    const job = object(resultContent(result)["job"]);
    assert.equal(job["requestId"], requestId, JSON.stringify(result));
    if (terminal.has(String(job["state"]))) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Public job ${requestId} did not become terminal: ${JSON.stringify(result)}`,
  );
}

type OfflineBroker = ReturnType<typeof fixture.startOfflineBroker>;

async function createPublicUnknown(
  t: TestContext,
  broker: OfflineBroker,
): Promise<{
  unknown: Record<string, unknown>;
  original: Record<string, unknown>;
}> {
  const client = fixture.startPublicMcp({
    directory: broker.home,
    clientId: "document-unlock-original-owner-a",
  });
  t.after(() => client.kill());
  await client.initialize();
  client.notifyInitialized();

  const hold = broker.holdNextSdkOperation({ loseAcknowledgement: true });
  let publicResult: unknown;
  const call = client
    .callTool("fmcad_execute", applyArguments(documentA, "12 mm"), {
      requestId: unknownRequestId,
    })
    .then((result) => {
      publicResult = result;
    })
    .catch((error: unknown) => {
      publicResult = { error: String(error) };
    });
  const summarizeOutcome = (requestId: string) => {
    const outcome = broker.jobOutcome(requestId);
    if (!outcome) return null;
    const pythonCheck = outcome["pythonCheck"]
      ? object(outcome["pythonCheck"])
      : {};
    const diagnostics = Array.isArray(pythonCheck["diagnostics"])
      ? (pythonCheck["diagnostics"] as Array<Record<string, unknown>>)
      : [];
    return {
      state: outcome["state"],
      code: outcome["code"],
      executionOutcome: outcome["executionOutcome"],
      userScriptSubmitted: outcome["userScriptSubmitted"],
      sdkSettled: outcome["sdkSettled"],
      mayHaveMutated: outcome["mayHaveMutated"],
      pythonCheck: outcome["pythonCheck"]
        ? {
            status: pythonCheck["status"],
            diagnosticCount: diagnostics.length,
            diagnostics: diagnostics.slice(0, 5).map((diagnostic) => ({
              rule: diagnostic["rule"],
              line: diagnostic["line"],
              message: diagnostic["message"],
            })),
          }
        : undefined,
    };
  };
  let dispatched: Awaited<typeof hold.started>;
  let timer: NodeJS.Timeout | undefined;
  try {
    dispatched = await Promise.race([
      hold.started,
      broker.waitForJobTerminal(unknownRequestId).then((current) => {
        throw new Error(
          `public param.apply reached a terminal state before the fake SDK dispatch; result=${JSON.stringify(publicResult)}; job=${JSON.stringify(
            {
              id: current["id"],
              state: current["state"],
              code: current["code"],
              details: current["details"],
            },
          )}; outcome=${JSON.stringify(summarizeOutcome(unknownRequestId))}; calls=${broker.calls.length}; diagnostics=${client.diagnostics()}`,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          let job: unknown;
          try {
            const current = broker.originalJob(unknownRequestId);
            job = {
              id: current["id"],
              state: current["state"],
              code: current["code"],
              details: current["details"],
            };
          } catch (error) {
            job = String(error);
          }
          reject(
            new Error(
              `public param.apply did not reach the fake SDK; result=${JSON.stringify(publicResult)}; job=${JSON.stringify(job)}; outcome=${JSON.stringify(summarizeOutcome(unknownRequestId))}; calls=${broker.calls.length}; diagnostics=${client.diagnostics()}`,
            ),
          );
        }, 45_000);
      }),
    ]);
  } catch (error) {
    await client.kill();
    hold.release();
    await call;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  assert.equal(dispatched.operation, "param.apply");
  assert.equal(dispatched.docId, documentA);
  await client.kill();
  hold.release();
  await hold.completed;
  await call;

  const unknown = await broker.waitForUnknown(unknownRequestId);
  assert.equal(unknown["state"], "needs_reconciliation");
  const recoveredClient = fixture.startPublicMcp({
    directory: broker.home,
    clientId: "document-unlock-original-owner-a",
  });
  t.after(() => recoveredClient.kill());
  await recoveredClient.initialize();
  recoveredClient.notifyInitialized();
  const recoveredRequest = await recoveredClient.callTool(
    "fmcad_queue_request",
    { requestId: unknownRequestId },
  );
  const publicUnknown = await waitForPublicJob(
    recoveredClient,
    recoveredRequest,
    unknownRequestId,
  );
  assert.equal(
    object(resultContent(publicUnknown)["job"])["state"],
    "needs_reconciliation",
    "the owner must observe the original UNKNOWN through a terminal public queue result",
  );
  await recoveredClient.close();

  const original = broker.originalJob(unknownRequestId);
  assert.equal(original["requestId"], unknownRequestId);
  assert.equal(original["state"], "needs_reconciliation");
  assert.equal(object(original["request"])["requestId"], unknownRequestId);
  assert.equal(typeof original["hash"], "string");
  const physicalDispatches = original["physicalDispatches"] as Array<
    Record<string, unknown>
  >;
  const productDispatches = physicalDispatches.filter(
    (dispatch) => object(dispatch["request"])["kind"] === "product",
  );
  assert.equal(productDispatches.length, 1);
  assert.equal(
    object(productDispatches[0]!["request"])["requestHash"],
    original["hash"],
    "the one physical intent must remain bound to the original request hash",
  );
  assert.equal(broker.dispatchCount("param.apply", documentA), 1);
  const intentHashes = broker.originalIntentHashes(unknownRequestId);
  assert.equal(Object.keys(intentHashes).length, physicalDispatches.length);
  for (const dispatch of physicalDispatches) {
    assert.equal(
      intentHashes[String(dispatch["intentReference"])],
      dispatch["intentDigest"],
      "the original physical intent receipt must remain byte-identical",
    );
  }
  return { unknown, original };
}

test("public MCP stdio advertises the document-unlock workflow and strict input", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-unlock-public-mcp-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fixture.preparePublicEnvironment(directory);
  const client = fixture.startPublicMcp({
    directory,
    clientId: "document-unlock-contract-client",
  });
  t.after(() => client.kill?.());

  await client.initialize();
  client.notifyInitialized();
  const tools = (await client.tools()).tools.map(object);
  const unlock = tools.find((tool) => tool["name"] === "fmcad_document_unlock");
  assert(unlock, "the public fmcad MCP must expose fmcad_document_unlock");
  const schema = object(unlock["inputSchema"]);
  assert.equal(schema["additionalProperties"], false);
  assert.deepEqual(schema["required"], ["action", "target"]);
  const properties = object(schema["properties"]);
  assert.deepEqual(properties["action"], {
    type: "string",
    enum: ["status", "inspect", "accept"],
  });
  const target = object(properties["target"]);
  assert.equal(target["type"], "object");
  assert.equal(target["minProperties"], 1);
  assert.equal(target["additionalProperties"], false);
  assert.deepEqual(Object.keys(object(target["properties"])).sort(), [
    "docFileId",
    "docId",
  ]);
  const targetProperties = object(target["properties"]);
  for (const identity of ["docId", "docFileId"]) {
    const property = object(targetProperties[identity]);
    assert.equal(property["type"], "string");
    assert.equal(property["minLength"], 1);
    assert.equal(property["maxLength"], 256);
  }
  const requestId = object(properties["requestId"]);
  assert.equal(requestId["type"], "string");
  assert.equal(requestId["minLength"], 1);
  assert.equal(requestId["maxLength"], 256);
  const observationId = object(properties["observationId"]);
  assert.equal(observationId["type"], "string");
  assert.equal(observationId["minLength"], 1);
  assert.equal(observationId["maxLength"], 256);
  await assert.rejects(
    client.callTool("fmcad_document_unlock", {
      action: "status",
      target: { docId: documentA },
      force: true,
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      String(object(error)["code"]).includes("32602"),
    "strict public MCP input must reject privileged and unknown fields",
  );
  await client.close();
});

test("public CLI recognizes the document-unlock action instead of rejecting it as an unknown queue command", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-unlock-public-cli-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fixture.preparePublicEnvironment(directory);

  const result = await fixture.runPublicCli({
    directory,
    clientId: "document-unlock-cli-client",
    args: [
      "queue",
      "document-unlock",
      "--action",
      "status",
      "--doc-id=--leading-dash-document",
    ],
  });
  assert.notEqual(result.signal, "SIGKILL");
  assert.doesNotMatch(
    result.stderr + result.stdout,
    /Unknown queue command|Invalid or duplicate queue option: --action/,
    "the CLI must route the action through its public queue adapter",
  );
  assert.match(
    result.stderr + result.stdout,
    /"code":\s*"DOCUMENT_UNLOCK_ERROR"/,
    "the recognized CLI action should return its safe document-unlock error",
  );
  assert.match(
    result.stderr + result.stdout,
    /review_original_request_without_replay/,
    "the CLI failure must preserve the safe no-replay next action",
  );

  const invalid = await fixture.runPublicCli({
    directory,
    clientId: "document-unlock-cli-client",
    args: [
      "queue",
      "document-unlock",
      "--action",
      "accept",
      `--doc-id=${documentA}`,
      "--request-id",
      "invalid-cli-accept",
      "--observation-id",
      "not-used",
      "--force",
    ],
  });
  assert.notEqual(invalid.code, 0);
  assert.match(
    invalid.stderr + invalid.stdout,
    /Unsupported document-unlock option|Invalid document unlock request/i,
    "the CLI must reject privileged fields before contacting the broker",
  );
});

test(
  "public MCP preserves UNKNOWN after one fake SDK dispatch and a lost acknowledgement",
  { timeout: 90_000 },
  async (t) => {
    const broker = fixture.startOfflineBroker(t);
    await broker.ready();
    const { unknown, original } = await createPublicUnknown(t, broker);
    assert.equal(unknown["state"], "needs_reconciliation");
    assert.equal(original["state"], "needs_reconciliation");
    assert.equal(broker.dispatchCount("param.apply", documentA), 1);
  },
);

test(
  "public UNKNOWN handoff survives independent work, alias races, acceptance, restart and readback",
  { timeout: 240_000 },
  async (t) => {
    const broker = fixture.startOfflineBroker(t);
    await broker.ready();
    const { original: originalUnknown } = await createPublicUnknown(t, broker);
    const originalUnknownHash = originalUnknown["hash"];
    const originalIntentHashes = broker.originalIntentHashes(unknownRequestId);

    const startMcp = async (clientId: string) => {
      const process = fixture.startPublicMcp({
        directory: broker.home,
        clientId,
      });
      t.after(() => process.kill());
      await process.initialize();
      process.notifyInitialized();
      return process;
    };
    const successor = await startMcp("document-unlock-successor-b");
    const independent = await startMcp("document-unlock-independent-c");
    const rejected = await startMcp("document-unlock-rejected-d");

    const independentAccepted = await independent.callTool(
      "fmcad_execute",
      applyArguments(documentB, "8 mm"),
      { requestId: requestId("independent-c-b") },
    );
    const independentApply = await waitForPublicJob(
      independent,
      independentAccepted,
      requestId("independent-c-b"),
    );
    assertMcpSuccess(independentApply);
    assert.equal(
      object(resultContent(independentApply)["job"])["state"],
      "succeeded",
      JSON.stringify(independentApply),
    );
    assert.equal(
      broker.dispatchCount("param.apply", documentB),
      1,
      JSON.stringify({
        result: independentApply,
        job: broker.originalJob(requestId("independent-c-b")),
        outcome: broker.jobOutcome(requestId("independent-c-b")),
        operations: broker.operations,
      }),
    );
    assert.equal(
      broker.originalJob(unknownRequestId)["state"],
      "needs_reconciliation",
      "independent document work must not settle or replace the original UNKNOWN",
    );

    const blockedAccepted = await successor.callTool(
      "fmcad_execute",
      applyArguments(documentA, "14 mm"),
      { requestId: requestId("blocked-apply-a") },
    );
    const blockedApply = await waitForPublicJob(
      successor,
      blockedAccepted,
      requestId("blocked-apply-a"),
    );
    const blockedJob = broker.originalJob(requestId("blocked-apply-a"));
    assert.equal(
      object(resultContent(blockedApply)["job"])["state"],
      "failed",
      JSON.stringify(blockedApply),
    );
    assert.equal(blockedJob["code"], "DOCUMENT_UNLOCK_REQUIRED");
    const blockedDetails = object(blockedJob["details"]);
    assert.equal(blockedDetails["executionOutcome"], "not_started");
    assert.equal(blockedDetails["userScriptSubmitted"], false);
    const publicBlockedJob = object(resultContent(blockedApply)["job"]);
    assert.equal(
      publicBlockedJob["code"],
      "DOCUMENT_UNLOCK_REQUIRED",
      JSON.stringify(blockedApply),
    );
    assert.equal(
      broker.dispatchCount("param.apply", documentA),
      1,
      "a different client cannot mutate A before accepting its readback",
    );

    const statusResponse = await successor.callTool("fmcad_document_unlock", {
      action: "status",
      target: { docFileId: fileA },
    });
    const status = assertMcpSuccess(statusResponse);
    assert.equal(status["state"], "inspection_required");
    const resolvedTarget = object(status["target"]);
    assert.equal(resolvedTarget["docFileId"], fileA);
    assert.doesNotMatch(
      JSON.stringify(status),
      /12 mm|unlock_width|clientToken|PRIVATE_/,
      "status may identify the blocker but must not expose the predecessor's request body or credentials",
    );
    const cliStatus = cliOutput(
      await fixture.runPublicCli({
        directory: broker.home,
        clientId: "document-unlock-successor-b",
        args: unlockCliArgs({
          action: "status",
          target: { docFileId: fileA },
        }),
      }),
    );
    assert.deepEqual(
      cliStatus,
      status,
      "MCP and CLI must expose the same safe status DTO",
    );

    const privilegedReadsBeforeMismatch = broker.dispatchCount(
      "param.inspect",
      documentA,
    );
    const conflictingAliases = await successor.callTool(
      "fmcad_document_unlock",
      {
        action: "inspect",
        target: { docId: documentA, docFileId: fileB },
        requestId: requestId("mismatched-alias"),
      },
    );
    assert.equal(
      object(conflictingAliases)["isError"],
      true,
      "mismatched creationId and fileId aliases must be refused",
    );
    assert.equal(
      broker.dispatchCount("param.inspect", documentA),
      privilegedReadsBeforeMismatch,
      "a failed identity probe must not dispatch the privileged full parameter read",
    );

    const firstInspectResponse = await successor.callTool(
      "fmcad_document_unlock",
      {
        action: "inspect",
        target: { docId: documentA, docFileId: fileA },
        requestId: requestId("inspect-creation"),
      },
    );
    assert.notEqual(
      object(firstInspectResponse)["isError"],
      true,
      JSON.stringify({
        result: firstInspectResponse,
        jobs: broker.jobSummaries(),
        operations: broker.operations,
        checkpoints: broker.documentCheckpointState(),
      }),
    );
    const firstInspect = resultContent(firstInspectResponse);
    assert.equal(firstInspect["state"], "inspection_required");
    const firstObservationId = String(
      object(firstInspect["observation"])["observationId"],
    );
    assert.ok(firstObservationId);

    const secondInspect = cliOutput(
      await fixture.runPublicCli({
        directory: broker.home,
        clientId: "document-unlock-successor-b",
        args: unlockCliArgs({
          action: "inspect",
          target: { docId: documentA, docFileId: fileA },
          requestId: requestId("inspect-creation-and-file"),
        }),
      }),
    );
    assert.equal(secondInspect["state"], "inspection_required");
    const secondObservationId = String(
      object(secondInspect["observation"])["observationId"],
    );
    assert.ok(secondObservationId);
    assert.notEqual(secondObservationId, firstObservationId);
    assert.equal(
      broker.dispatchCount("param.inspect", documentA),
      2,
      "both agreeing public aliases must resolve to the same document and read its parameters",
    );

    const foreignAcceptance = await rejected.callTool("fmcad_document_unlock", {
      action: "accept",
      target: { docId: documentA },
      requestId: requestId("foreign-accept"),
      observationId: firstObservationId,
    });
    assertMcpFailure(foreignAcceptance, "NOT_AUTHORIZED");
    assert.equal(
      JSON.stringify(foreignAcceptance).includes(firstObservationId),
      false,
      "a rejected actor must not learn another client's private observation ID",
    );
    const falseProof = await successor.callTool("fmcad_document_unlock", {
      action: "accept",
      target: { docId: documentA },
      requestId: requestId("false-proof"),
      observationId: "invented-observation-id",
    });
    assertMcpFailure(falseProof, "NOT_AUTHORIZED");
    assert.equal(
      broker.dispatchCount("param.inspect", documentA),
      2,
      "foreign and invented observations must be refused before a full read",
    );

    const staleReadHold = broker.holdNextSdkOperation({
      operation: "param.inspect",
    });
    const staleReadRequestId = requestId("pending-file-only-inspect");
    const staleRead = successor.callTool("fmcad_document_unlock", {
      action: "inspect",
      target: { docFileId: fileA },
      requestId: staleReadRequestId,
    });
    const pendingRead = await staleReadHold.started;
    assert.equal(pendingRead.operation, "param.inspect");
    assert.equal(pendingRead.docId, documentA);
    const activeAcceptance = await fixture.runPublicCli({
      directory: broker.home,
      clientId: "document-unlock-successor-b",
      args: unlockCliArgs({
        action: "accept",
        target: { docId: documentA },
        requestId: requestId("accept-during-active-read"),
        observationId: firstObservationId,
      }),
    });
    assert.equal(activeAcceptance.signal, null, activeAcceptance.stderr);
    assert.equal(activeAcceptance.code, 1, activeAcceptance.stderr);
    assert.match(
      activeAcceptance.stdout + activeAcceptance.stderr,
      /"code":\s*"SDK_TURN_ACTIVE"/,
    );
    assert.equal(
      Object.keys(broker.documentCheckpointState().acceptances).length,
      0,
      "an observation cannot be accepted while its physical read is active",
    );
    staleReadHold.release();
    await staleReadHold.completed;
    const staleReadResult = assertMcpSuccess(await staleRead);
    assert.equal(staleReadResult["state"], "inspection_required");
    const thirdObservationId = String(
      object(staleReadResult["observation"])["observationId"],
    );
    assert.ok(thirdObservationId);
    assert.equal(
      broker.dispatchCount("param.inspect", documentA),
      3,
      "the full read finishes once after the active SDK turn is released",
    );

    const accepted = cliOutput(
      await fixture.runPublicCli({
        directory: broker.home,
        clientId: "document-unlock-successor-b",
        args: unlockCliArgs({
          action: "accept",
          target: { docId: documentA },
          requestId: requestId("accept-after-quiescence"),
          observationId: thirdObservationId,
        }),
      }),
    );
    assert.equal(accepted["state"], "checkpoint_current");

    const staleAliasAcceptance = await successor.callTool(
      "fmcad_document_unlock",
      {
        action: "accept",
        target: { docId: documentA, docFileId: fileA },
        requestId: requestId("accept-stale-alias"),
        observationId: secondObservationId,
      },
    );
    assertMcpFailure(staleAliasAcceptance, "CHECKPOINT_CHANGED");
    const durableCheckpoints = broker.documentCheckpointState();
    assert.equal(Object.keys(durableCheckpoints.acceptances).length, 1);
    assert.equal(Object.keys(durableCheckpoints.heads).length, 1);
    const acceptedReceipt = Object.values(durableCheckpoints.acceptances)[0]!;
    assert.equal(acceptedReceipt["observationId"], thirdObservationId);
    assert.equal(
      broker.originalJob(unknownRequestId)["state"],
      "needs_reconciliation",
      "acceptance is a separate checkpoint receipt, not settlement of the old request",
    );

    const currentMcp = assertMcpSuccess(
      await successor.callTool("fmcad_document_unlock", {
        action: "status",
        target: { docId: documentA },
      }),
    );
    assert.equal(
      currentMcp["state"],
      "inspection_required",
      "status without a selected observation does not claim that an accepted checkpoint is still current",
    );
    const currentCli = cliOutput(
      await fixture.runPublicCli({
        directory: broker.home,
        clientId: "document-unlock-successor-b",
        args: unlockCliArgs({
          action: "status",
          target: { docId: documentA },
        }),
      }),
    );
    assert.deepEqual(
      currentCli,
      currentMcp,
      "MCP and CLI status results must agree after acceptance",
    );

    const freshApplyAccepted = await successor.callTool(
      "fmcad_execute",
      applyArguments(documentA, "16 mm"),
      { requestId: requestId("fresh-apply-a") },
    );
    const freshApply = await waitForPublicJob(
      successor,
      freshApplyAccepted,
      requestId("fresh-apply-a"),
    );
    assertMcpSuccess(freshApply);
    assert.equal(
      object(resultContent(freshApply)["job"])["state"],
      "succeeded",
      JSON.stringify(freshApply),
    );
    assert.equal(broker.dispatchCount("param.apply", documentA), 2);
    assert.equal(
      broker.originalJob(requestId("fresh-apply-a"))["state"],
      "succeeded",
    );
    const readsBeforePostApplyReadback = broker.dispatchCount(
      "param.inspect",
      documentA,
    );
    const readback = assertMcpSuccess(
      await successor.callTool("fmcad_document_unlock", {
        action: "inspect",
        target: { docId: documentA, docFileId: fileA },
        requestId: requestId("post-accept-readback-a"),
      }),
    );
    assert.equal(readback["state"], "inspection_required");
    assert.equal(
      object(readback["observed"])["schema"],
      "fmcad.param-checkpoint-v1",
    );
    assert.match(JSON.stringify(readback["observed"]), /16 mm/);
    assert.equal(
      broker.dispatchCount("param.inspect", documentA),
      readsBeforePostApplyReadback + 1,
      "public post-apply readback dispatches one complete parameter inspection",
    );

    await successor.close();
    await independent.close();
    await rejected.close();
    await broker.close();
    const restartedBroker = fixture.startOfflineBroker(t, {
      home: broker.home,
    });
    await restartedBroker.ready();
    const restartedClient = fixture.startPublicMcp({
      directory: restartedBroker.home,
      clientId: "document-unlock-successor-b",
    });
    t.after(() => restartedClient.kill());
    await restartedClient.initialize();
    restartedClient.notifyInitialized();
    const afterRestart = assertMcpSuccess(
      await restartedClient.callTool("fmcad_document_unlock", {
        action: "status",
        target: { docId: documentA },
      }),
    );
    assert.equal(
      afterRestart["state"],
      "inspection_required",
      "restart status does not advertise a post-mutation checkpoint as accepted",
    );
    const oldGenerationAcceptance = await restartedClient.callTool(
      "fmcad_document_unlock",
      {
        action: "accept",
        target: { docId: documentA },
        requestId: requestId("after-restart-old-observation"),
        observationId: secondObservationId,
      },
    );
    assertMcpFailure(oldGenerationAcceptance, "DOCUMENT_STATE_CHANGED");
    const restoredUnknown = restartedBroker.originalJob(unknownRequestId);
    assert.equal(restoredUnknown["state"], "needs_reconciliation");
    assert.equal(restoredUnknown["hash"], originalUnknownHash);
    const restoredDispatches = (
      restoredUnknown["physicalDispatches"] as Array<Record<string, unknown>>
    ).filter((dispatch) => object(dispatch["request"])["kind"] === "product");
    assert.equal(restoredDispatches.length, 1);
    assert.deepEqual(
      restartedBroker.originalIntentHashes(unknownRequestId),
      originalIntentHashes,
      "restart must preserve the original intent receipt without replay",
    );
    const restoredCheckpoints = restartedBroker.documentCheckpointState();
    assert.equal(Object.keys(restoredCheckpoints.acceptances).length, 1);
    assert.equal(
      Object.values(restoredCheckpoints.acceptances)[0]?.["observationId"],
      thirdObservationId,
    );
    assert.equal(restartedBroker.dispatchCount("param.apply", documentA), 0);
  },
);
