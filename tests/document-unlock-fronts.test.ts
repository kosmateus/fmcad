import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";

const load = createRequire(
  path.join(process.cwd(), "tests", "document-unlock-fronts.test.ts"),
);
const core = load("@fmcad/core") as {
  decodeDocumentUnlockRequest(value: unknown): unknown;
  decodeDocumentUnlockPublicError(value: unknown): unknown;
  documentUnlockIpcFailure(): unknown;
};

test("document unlock decoder accepts only the three exact request shapes", () => {
  assert.deepEqual(
    core.decodeDocumentUnlockRequest({
      action: "status",
      target: { docId: "creation-1" },
    }),
    { action: "status", target: { docId: "creation-1" } },
  );
  assert.deepEqual(
    core.decodeDocumentUnlockRequest({
      action: "status",
      target: { docId: "creation-1", docFileId: "file-1" },
      requestId: "status-1",
    }),
    {
      action: "status",
      target: { docId: "creation-1", docFileId: "file-1" },
      requestId: "status-1",
    },
  );
  assert.deepEqual(
    core.decodeDocumentUnlockRequest({
      action: "inspect",
      target: { docFileId: "file-1" },
      requestId: "inspect-1",
    }),
    {
      action: "inspect",
      target: { docFileId: "file-1" },
      requestId: "inspect-1",
    },
  );
  assert.deepEqual(
    core.decodeDocumentUnlockRequest({
      action: "accept",
      target: { docId: "creation-1" },
      requestId: "accept-1",
      observationId: "observation-1",
    }),
    {
      action: "accept",
      target: { docId: "creation-1" },
      requestId: "accept-1",
      observationId: "observation-1",
    },
  );
});

test("document unlock decoder rejects missing, mixed, malformed, and privileged fields", () => {
  const invalid = [
    null,
    [],
    {},
    { action: "other", target: { docId: "doc" } },
    { action: "status", target: {} },
    { action: "status", target: { docId: "" } },
    { action: "status", target: { docId: "x".repeat(257) } },
    {
      action: "status",
      target: { docId: "doc" },
      requestId: "r".repeat(257),
    },
    { action: "status", target: { docId: "doc", owner: "someone" } },
    { action: "status", target: { docId: "doc" }, unknown: true },
    {
      action: "status",
      target: { docId: "doc" },
      observationId: "observation",
    },
    { action: "inspect", target: { docId: "doc" } },
    {
      action: "inspect",
      target: { docId: "doc" },
      requestId: "",
    },
    {
      action: "inspect",
      target: { docId: "doc" },
      requestId: "request",
      observationId: "observation",
    },
    {
      action: "accept",
      target: { docId: "doc" },
      requestId: "request",
    },
    {
      action: "accept",
      target: { docId: "doc" },
      requestId: "request",
      observationId: "observation",
      force: true,
    },
    {
      action: "accept",
      target: { docId: "doc" },
      requestId: "request",
      observationId: "observation",
      clientToken: "secret",
    },
    {
      action: "accept",
      target: { docId: "doc" },
      requestId: "request",
      observationId: "o".repeat(257),
    },
  ];
  for (const request of invalid)
    assert.throws(() => core.decodeDocumentUnlockRequest(request));
});

test("public broker errors accept only the safe DTO fields and fixed messages", () => {
  const failure = core.documentUnlockIpcFailure() as Record<string, unknown>;
  assert.deepEqual(core.decodeDocumentUnlockPublicError(failure), failure);
  assert.throws(
    () =>
      core.decodeDocumentUnlockPublicError({
        ...failure,
        error: {
          ...(failure["error"] as Record<string, unknown>),
          message: "PRIVATE_ERROR_MESSAGE_SENTINEL",
        },
      }),
    /Invalid document unlock public error/,
  );
  assert.throws(
    () =>
      core.decodeDocumentUnlockPublicError({
        ...failure,
        stack: "PRIVATE_STACK_SENTINEL",
      }),
    /Invalid document unlock public error/,
  );
});

test("MCP registers one strict document unlock tool and preserves broker next values", async () => {
  const { createMcpApplication } = load("../src/dist/entrypoints/mcp.js") as {
    createMcpApplication(
      options: Record<string, unknown>,
    ): (request: Record<string, unknown>) => Promise<{ raw: string }>;
  };
  const calls: unknown[] = [];
  let brokerResponse: unknown = {
    state: "inspection_required",
    blockers: [{ requestId: "old-unknown" }],
    next: { action: "inspect", requestId: "inspect-1" },
  };
  let ipcFailure: unknown;
  let starts = 0;
  const app = createMcpApplication({
    catalog: {
      tools: () => [],
      list: () => [],
    },
    catalogTools: [],
    catalogContracts: [],
    services: () => ({
      start: async () => {
        starts++;
      },
      documentUnlock: async (request: unknown) => {
        calls.push(request);
        if (ipcFailure) throw ipcFailure;
        return brokerResponse;
      },
    }),
    compatibility: async () => {
      throw new Error("unexpected compatibility route");
    },
    queueTools: [],
  });
  const listed = JSON.parse(
    (await app({ jsonrpc: "2.0", id: 1, method: "tools/list" })).raw,
  ) as { result: { tools: Array<Record<string, unknown>> } };
  const tool = listed.result.tools.filter(
    (entry) => entry["name"] === "fmcad_document_unlock",
  );
  assert.equal(tool.length, 1);
  assert.equal(
    (tool[0]!["inputSchema"] as Record<string, unknown>)[
      "additionalProperties"
    ],
    false,
  );

  const input = {
    action: "inspect",
    target: { docFileId: "file-1" },
    requestId: "inspect-1",
  };
  const response = JSON.parse(
    (
      await app({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fmcad_document_unlock", arguments: input },
      })
    ).raw,
  ) as { result: { structuredContent: unknown } };
  assert.deepEqual(calls, [input]);
  assert.deepEqual(response.result.structuredContent, brokerResponse);
  assert.equal(starts, 1);

  const refusal = {
    error: {
      code: "REQUEST_CONFLICT",
      message:
        "This request ID is already bound to different content. Use a fresh request ID for any new request; do not retry the same ID with changed content.",
    },
    next: {
      kind: "operator_action",
      action: "review_original_request_without_replay",
      instruction:
        "Check the original request's durable status only if authorized; do not replay it. Use a fresh request ID for genuinely new content.",
    },
  };
  brokerResponse = refusal;
  const refusalResponse = JSON.parse(
    (
      await app({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fmcad_document_unlock", arguments: input },
      })
    ).raw,
  ) as {
    result: {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: unknown;
    };
  };
  assert.equal(refusalResponse.result.isError, true);
  assert.equal(refusalResponse.result.content[0]?.text, refusal.error.message);
  assert.deepEqual(refusalResponse.result.structuredContent, refusal);

  ipcFailure = Object.assign(new Error("PRIVATE_IPC_MESSAGE_SENTINEL"), {
    code: "PRIVATE_IPC_CODE_SENTINEL",
    cause: new Error("PRIVATE_CAUSE_SENTINEL"),
    next: { token: "PRIVATE_NEXT_SENTINEL" },
  });
  const ipcErrorResponse = JSON.parse(
    (
      await app({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "fmcad_document_unlock", arguments: input },
      })
    ).raw,
  ) as {
    result: {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: unknown;
    };
  };
  assert.equal(ipcErrorResponse.result.isError, true);
  assert.doesNotMatch(
    JSON.stringify(ipcErrorResponse),
    /PRIVATE_(?:IPC_MESSAGE|IPC_CODE|CAUSE|NEXT)_SENTINEL/,
  );
  assert.deepEqual(
    ipcErrorResponse.result.structuredContent,
    core.documentUnlockIpcFailure(),
  );
  ipcFailure = undefined;
  assert.equal(starts, 3);

  const invalidResponse = JSON.parse(
    (
      await app({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "fmcad_document_unlock",
          arguments: {
            action: "accept",
            target: { docId: "doc-1" },
            requestId: "accept-1",
          },
        },
      })
    ).raw,
  ) as { error: { code: number } };
  assert.equal(invalidResponse.error.code, -32602);
  assert.equal(calls.length, 3);
});

test("OpenCode v1 and v2 document unlock tools use the permission-checked control service", async () => {
  const input = {
    action: "inspect",
    target: { docId: "creation-1" },
    requestId: "inspect-1",
  };
  const response = {
    state: "inspection_required",
    next: { action: "accept", requestId: "inspect-1" },
  };
  const permissions: unknown[] = [];
  const calls: unknown[] = [];
  const checkAndAttemptMutation = (permission: unknown) => {
    permissions.push(permission);
    const input = permission as Record<string, unknown>;
    const action = input["action"] || input["permission"];
    if (action !== "fmcad_execute") return;
    const metadata = input["metadata"] as Record<string, unknown>;
    const authorized = metadata["input"] as Record<string, unknown>;
    const target = authorized["target"] as Record<string, unknown>;
    assert.equal(Object.isFrozen(authorized), true);
    assert.equal(Object.isFrozen(target), true);
    assert.equal(Reflect.set(authorized, "action", "accept"), false);
    assert.equal(
      Reflect.set(authorized, "requestId", "changed-request"),
      false,
    );
    assert.equal(Reflect.set(target, "docId", "changed-document"), false);
  };
  const deps = {
    catalog: { list: () => [] },
    create: () => ({
      start: async () => {
        calls.push("start");
      },
      documentUnlock: async (request: unknown) => {
        calls.push(request);
        return response;
      },
      dispose: async () => {
        calls.push("dispose");
      },
    }),
    config: () => ({}),
    presence: () => null,
    clientID: () => "opencode-unlock-client",
    requestID: () => "generated-request",
    instanceID: "opencode-instance",
  };

  const v1 = load("../packages/opencode-adapter/dist/v1/index.js") as {
    createV1(dependencies: typeof deps): (
      host: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{
      tool: Record<
        string,
        {
          execute(
            value: unknown,
            context: Record<string, unknown>,
          ): Promise<unknown>;
        }
      >;
      dispose(): Promise<void>;
    }>;
  };
  const v1Plugin = v1.createV1(deps);
  const v1Hooks = await v1Plugin(
    {
      directory: "/plugin",
      client: { session: { get: async () => undefined } },
    },
    {},
  );
  const v1Result = await v1Hooks.tool["fmcad_document_unlock"]!.execute(input, {
    directory: "/project/document-unlock",
    worktree: "/project",
    sessionID: "v1-session",
    agent: "build",
    abort: new AbortController().signal,
    ask: async (permission: unknown) => checkAndAttemptMutation(permission),
  });
  assert.deepEqual(JSON.parse(String(v1Result)), response);
  assert.deepEqual(calls.slice(0, 2), ["start", input]);
  assert.equal(
    (permissions[0] as Record<string, unknown>)["permission"],
    "fmcad_execute",
  );
  await v1Hooks.dispose();

  calls.length = 0;
  permissions.length = 0;
  const v2 = load("../packages/opencode-adapter/dist/v2/index.js") as {
    createV2(dependencies: typeof deps): {
      setup(context: Record<string, unknown>): Promise<() => Promise<void>>;
    };
  };
  const definitions: Record<
    string,
    {
      execute(
        value: unknown,
        context: Record<string, unknown>,
      ): Promise<{ content: string }>;
    }
  > = {};
  const cleanup = await v2.createV2(deps).setup({
    app: { version: "2.1.3" },
    options: {},
    location: { directory: "/plugin" },
    session: {
      get: async () => ({
        projectID: "project-1",
        location: { directory: "/project/document-unlock" },
      }),
    },
    permission: {
      assert: async (permission: unknown) =>
        checkAndAttemptMutation(permission),
    },
    event: {
      subscribe: async function* () {},
    },
    tool: {
      transform: async (
        register: (editor: {
          add(definition: {
            name: string;
            execute(
              value: unknown,
              context: Record<string, unknown>,
            ): Promise<{ content: string }>;
          }): void;
        }) => void,
      ) => {
        register({
          add(definition) {
            definitions[definition.name] = definition;
          },
        });
        return { dispose: async () => undefined };
      },
    },
  });
  const v2Result = await definitions["fmcad_document_unlock"]!.execute(input, {
    sessionID: "v2-session",
    agent: "build",
    messageID: "message-1",
    id: "call-1",
    signal: new AbortController().signal,
  });
  assert.deepEqual(JSON.parse(v2Result.content), response);
  assert.deepEqual(calls.slice(0, 2), ["start", input]);
  assert.equal(
    (permissions[0] as Record<string, unknown>)["action"],
    "fmcad_execute",
  );
  await cleanup();
});

test("QueueClient and queue CLI send a nested strict request on the document-unlock IPC action", async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-document-unlock-fronts-"),
  );
  const previousStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = temporary;
  t.after(() => {
    if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previousStateHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const connection = load("../src/queue-connection.js") as {
    request: (
      directory: string,
      message: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  const originalRequest = connection.request;
  const messages: Record<string, unknown>[] = [];
  let brokerResponse: unknown = {
    state: "inspection_required",
    next: { action: "inspect", requestId: "next-inspect" },
  };
  let ipcFailure: unknown;
  connection.request = async (_directory, message) => {
    messages.push(message);
    if (message["action"] === "document-unlock") {
      if (ipcFailure) throw ipcFailure;
      return brokerResponse;
    }
    return { clientId: message["clientId"] };
  };
  t.after(() => {
    connection.request = originalRequest;
  });

  const { QueueClient } = load("../src/queue-client.js") as {
    QueueClient: new (
      clientId: string,
      options?: Record<string, unknown>,
    ) => {
      auth: { clientId: string; clientToken: string };
      register(): Promise<unknown>;
      documentUnlock(input: unknown): Promise<unknown>;
      dispose(): void;
    };
  };
  const client = new QueueClient("unlock-client");
  try {
    await client.register();
    const input = {
      action: "accept",
      target: { docId: "creation-1", docFileId: "file-1" },
      requestId: "accept-1",
      observationId: "observation-1",
    };
    const result = await client.documentUnlock(input);
    assert.strictEqual(result, brokerResponse);
    const message = messages.find(
      (entry) => entry["action"] === "document-unlock",
    );
    assert.ok(message);
    assert.deepEqual(message["request"], input);
    assert.deepEqual(message["auth"], client.auth);
    assert.equal(message["clientToken"], undefined);
    assert.equal(message["owner"], undefined);

    ipcFailure = Object.assign(new Error("PRIVATE_IPC_MESSAGE_SENTINEL"), {
      code: "PRIVATE_IPC_CODE_SENTINEL",
      cause: new Error("PRIVATE_CAUSE_SENTINEL"),
    });
    await assert.rejects(client.documentUnlock(input), (error: unknown) => {
      const failure = error as Error & { code?: string; cause?: unknown };
      assert.equal(failure.code, "DOCUMENT_UNLOCK_ERROR");
      assert.equal(
        failure.message,
        "The document unlock operation failed. No private error details are available.",
      );
      assert.equal(failure.cause, undefined);
      assert.doesNotMatch(
        JSON.stringify(failure),
        /PRIVATE_(?:IPC_MESSAGE|IPC_CODE|CAUSE)_SENTINEL/,
      );
      return true;
    });
    ipcFailure = undefined;

    const beforeInvalid = messages.length;
    await assert.rejects(
      client.documentUnlock({
        ...input,
        requestId: "accept-2",
        force: true,
      }),
    );
    assert.equal(messages.length, beforeInvalid);
  } finally {
    client.dispose();
  }

  const { queueCommand } = load("../src/dist/entrypoints/queue-cli.js") as {
    queueCommand(
      argv: string[],
      dependencies: {
        loadConfig(options: Record<string, string>): { cfg: unknown };
        stdout: { write(text: string): unknown };
        stderr: { write(text: string): unknown };
      },
    ): Promise<number>;
  };
  let output = "";
  let stderrOutput = "";
  const dependencies = {
    loadConfig: () => ({
      cfg: {
        backend: "addin",
        routing: "queue",
        url: "http://127.0.0.1:8765/mcp",
        headers: {},
        timeoutMs: 1000,
        tool: "execute_python",
        transport: "node",
        protocolVersion: "2025-06-18",
        queue: { client: "cli-unlock-client" },
        controlCenter: { port: 4748 },
      },
    }),
    stdout: { write: (text: string) => (output += text) },
    stderr: { write: (text: string) => (stderrOutput += text) },
  };
  const code = await queueCommand(
    ["document-unlock", "--action", "status", "--doc-file-id", "file-2"],
    dependencies,
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), brokerResponse);
  assert.deepEqual(
    messages.find(
      (entry) =>
        entry["action"] === "document-unlock" &&
        (entry["request"] as Record<string, unknown>)["action"] === "status",
    )?.["request"],
    { action: "status", target: { docFileId: "file-2" } },
  );
  output = "";
  const leadingDashExit = await queueCommand(
    ["document-unlock", "--action=status", "--doc-id=--fixture-id"],
    dependencies,
  );
  assert.equal(leadingDashExit, 0);
  assert.deepEqual(messages.at(-1)?.["request"], {
    action: "status",
    target: { docId: "--fixture-id" },
  });
  assert.equal(
    messages.some((entry) => entry["action"] === "submit"),
    false,
    "document unlock must not submit a CAD operation",
  );
  const refusal = {
    error: {
      code: "REQUEST_CONFLICT",
      message:
        "This request ID is already bound to different content. Use a fresh request ID for any new request; do not retry the same ID with changed content.",
    },
    next: {
      kind: "operator_action",
      action: "review_original_request_without_replay",
      instruction:
        "Check the original request's durable status only if authorized; do not replay it. Use a fresh request ID for genuinely new content.",
    },
  };
  brokerResponse = refusal;
  output = "";
  const refusalExit = await queueCommand(
    ["document-unlock", "--action", "status", "--doc-id", "creation-1"],
    dependencies,
  );
  assert.equal(refusalExit, 1);
  assert.deepEqual(JSON.parse(output), refusal);

  brokerResponse = { state: "clear" };
  ipcFailure = Object.assign(new Error("PRIVATE_IPC_MESSAGE_SENTINEL"), {
    code: "PRIVATE_IPC_CODE_SENTINEL",
    next: { token: "PRIVATE_NEXT_SENTINEL" },
  });
  output = "";
  const ipcFailureExit = await queueCommand(
    ["document-unlock", "--action", "status", "--doc-id", "creation-1"],
    dependencies,
  );
  assert.equal(ipcFailureExit, 1);
  assert.deepEqual(JSON.parse(output), core.documentUnlockIpcFailure());
  assert.doesNotMatch(
    output + stderrOutput,
    /PRIVATE_(?:IPC_MESSAGE|IPC_CODE|NEXT)_SENTINEL/,
  );
  ipcFailure = undefined;

  await assert.rejects(
    queueCommand(["status", "--action", "status"], dependencies),
    /restricted to document-unlock/,
  );
  await assert.rejects(
    queueCommand(
      [
        "document-unlock",
        "--action",
        "status",
        "--doc-file-id",
        "file-2",
        "--force",
        "true",
      ],
      dependencies,
    ),
    /Unsupported document-unlock option; see help/,
  );
  const secret = "CLIENT_TOKEN_SENTINEL";
  await assert.rejects(
    queueCommand(["document-unlock", `--client-token=${secret}`], dependencies),
    /Unsupported document-unlock option; see help/,
  );
  await assert.rejects(
    queueCommand(["document-unlock", secret], dependencies),
    /Unsupported document-unlock option; see help/,
  );
  assert.doesNotMatch(output + stderrOutput, /CLIENT_TOKEN_SENTINEL/);
});
