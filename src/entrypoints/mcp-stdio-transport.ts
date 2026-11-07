import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  JsonLineDecoder,
  MCP_MAX_INPUT_FRAME_BYTES,
  MCP_MAX_PENDING_REQUESTS,
  MCP_MAX_SIZE_DIAGNOSTICS,
  MCP_MAX_STDOUT_FRAME_BYTES,
  boundedDiagnosticLine,
  createMcpProtocolForwarder,
  externalizeMcpResponse,
  isObject,
  parseJsonRpcRequest,
  reportOwnedMcpResult,
  serializeMcpFrame,
  type FrameSendContext,
  type JsonRpcRequest,
  type InputFrame,
  type JsonRpcMessage,
  type McpForwarderOptions,
  type McpFrameSink,
  type OwnedMcpResultReporter,
  type OwnedResponseWriter,
  type ExternalizeContext,
} from "./mcp-framing.js";
import type { McpResponse } from "./mcp-framing.js";

export interface StdioWritable extends Writable {
  write(chunk: Uint8Array | string): boolean;
}

export interface McpFrameWriterOptions {
  externalize?: OwnedResponseWriter;
  onOwnedResult?: OwnedMcpResultReporter;
  onOutputClosed?(error?: Error): void;
  maxFrameBytes?: number;
}

/** Serializes only one output frame at a time and waits for drain when write() backpressures. */
export class McpFrameWriter implements McpFrameSink {
  readonly #output: StdioWritable;
  readonly #options: McpFrameWriterOptions;
  #tail: Promise<void> = Promise.resolve();
  #pendingSends = 0;
  #closed = false;

  constructor(output: StdioWritable, options: McpFrameWriterOptions = {}) {
    const maxFrameBytes = options.maxFrameBytes ?? MCP_MAX_STDOUT_FRAME_BYTES;
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 0 ||
      maxFrameBytes > MCP_MAX_STDOUT_FRAME_BYTES
    )
      throw new Error(
        "maxFrameBytes must be within the fixed MCP stdout limit",
      );
    this.#output = output;
    this.#options = options;
    output.on?.("error", this.#onError);
    output.on?.("close", this.#onClose);
  }

  async send(
    message: JsonRpcMessage,
    context: FrameSendContext,
  ): Promise<void> {
    this.#pendingSends++;
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed) return;
      const existingOwnedResult = context.response?.ownedArtifact;
      if (existingOwnedResult !== undefined && context.response !== undefined)
        reportOwnedMcpResult(
          this.#options.onOwnedResult,
          existingOwnedResult,
          context.response,
        );
      let output = message;
      let frame = serializeMcpFrame(output);
      const maxFrameBytes =
        this.#options.maxFrameBytes ?? MCP_MAX_STDOUT_FRAME_BYTES;
      if (frame.length >= maxFrameBytes) {
        if (!context.response)
          throw new Error(
            "Oversized local MCP response has no artifact source",
          );
        if (
          !Object.hasOwn(message, "id") ||
          (!Object.hasOwn(message, "result") &&
            !Object.hasOwn(message, "error"))
        )
          throw new Error(
            "Only complete JSON-RPC responses can be externalized",
          );
        output = await externalizeMcpResponse(
          context.request,
          message,
          context.response,
          this.#options.externalize,
        );
        frame = serializeMcpFrame(output);
      }
      if (frame.length >= maxFrameBytes)
        throw new Error(
          "Externalized MCP frame still exceeds the output limit",
        );
      await this.#write(frame);
    } finally {
      release();
      this.#pendingSends--;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.onOutputClosed?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pendingSends(): number {
    return this.#pendingSends;
  }

  readonly #onError = (error: Error & { code?: string }): void => {
    this.#closed = true;
    this.#options.onOutputClosed?.(error);
  };

  readonly #onClose = (): void => {
    this.#closed = true;
    this.#options.onOutputClosed?.();
  };

  async #write(frame: Buffer): Promise<void> {
    if (this.#closed) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.#output.removeListener?.("drain", onDrain);
        this.#output.removeListener?.("error", onError);
        this.#output.removeListener?.("close", onClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (error as (Error & { code?: string }) | undefined)?.code;
        if (code === "EPIPE") {
          this.#onError(error!);
          resolve();
        } else if (error) reject(error);
        else resolve();
      };
      const onDrain = () => finish();
      const onError = (error: Error) => finish(error);
      const onClose = () => finish();
      const supportsEvents = typeof this.#output.once === "function";
      this.#output.once?.("drain", onDrain);
      this.#output.once?.("error", onError);
      this.#output.once?.("close", onClose);
      try {
        if (this.#output.write(frame) !== false) finish();
        else if (!supportsEvents)
          finish(new Error("stdout backpressure cannot be drained"));
      } catch (error) {
        finish(error as Error);
      }
    });
  }
}

export interface McpStdioTransportOptions {
  input: Readable;
  output: StdioWritable;
  handle(frame: InputFrame): Promise<void>;
  isConcurrent?(line: string): boolean;
  pendingLimit?: number;
  maxInputFrameBytes?: number;
  externalize?: OwnedResponseWriter;
  onOwnedResult?: OwnedMcpResultReporter;
  onDiagnostic?(line: string): void;
}

export interface McpStdioTransport {
  readonly closed: Promise<void>;
  readonly writer: McpFrameWriter;
  readonly pendingRequests: number;
  close(): void;
}

export interface OwnedMcpResponseWriterOptions {
  directory: string;
  store: OwnedResponseStore;
  durable: DurableBytesPort;
  onOwnedResult?: OwnedMcpResultReporter;
  resolveProject?(
    request: JsonRpcRequest,
  ): string | null | Promise<string | null>;
}

interface OwnedArtifactJob {
  id: string;
  request?: { cwd: string };
}

export interface OwnedResponseStore {
  responsePath(
    directory: string,
    job: OwnedArtifactJob,
    name: "rpc-result.json",
    write: true,
  ): string;
  describeOwnedResult(
    directory: string,
    job: OwnedArtifactJob,
    name: "rpc-result.json",
  ): { artifact: import("./mcp-framing.js").OwnedMcpArtifactReference };
  regularDirectory(
    directory: string,
    components: string[],
    create?: boolean,
  ): string;
}

export interface DurableBytesPort {
  durable(file: string, value: unknown, exclusive?: boolean): void;
}

/** Reuses the existing owned-result path, writer and descriptor implementation. */
export function createOwnedMcpResponseWriter(
  options: OwnedMcpResponseWriterOptions,
): OwnedResponseWriter {
  const { directory, store, durable } = options;
  return async (contents, context: ExternalizeContext) => {
    const owner = context.response.artifactOwner;
    if (owner && !/^[A-Za-z0-9_-]+$/.test(owner.jobId))
      throw Object.assign(new Error("Invalid MCP artifact owner"), {
        code: "ARTIFACT_OWNER_UNAVAILABLE",
      });
    if (context.response.queueReceipt !== undefined && !owner)
      throw Object.assign(
        new Error("Queue result must reuse its existing artifact owner"),
        { code: "ARTIFACT_OWNER_UNAVAILABLE" },
      );
    const cwd = owner
      ? (owner.cwd ?? null)
      : ((await options.resolveProject?.(context.request)) ?? null);
    const job: OwnedArtifactJob = {
      id: owner?.jobId ?? randomUUID(),
      ...(cwd ? { request: { cwd } } : {}),
    };
    if (!cwd) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Object.assign(
          new Error("Owned response root must be a regular directory"),
          {
            code: "ARTIFACT_OWNER_UNAVAILABLE",
          },
        );
      store.regularDirectory(directory, ["jobs", job.id], true);
    }
    const file = store.responsePath(directory, job, "rpc-result.json", true);
    durable.durable(file, contents, true);
    const reference = store.describeOwnedResult(
      directory,
      job,
      "rpc-result.json",
    ).artifact;
    reportOwnedMcpResult(options.onOwnedResult, reference, context.response);
    return reference;
  };
}

/** Bounded stdio pump. EOF/EPIPE stop admission but wait for already accepted work. */
export function createMcpStdioTransport(
  options: McpStdioTransportOptions,
): McpStdioTransport {
  const pendingLimit = options.pendingLimit ?? MCP_MAX_PENDING_REQUESTS;
  if (
    !Number.isSafeInteger(pendingLimit) ||
    pendingLimit <= 0 ||
    pendingLimit > MCP_MAX_PENDING_REQUESTS
  )
    throw new Error("pendingLimit must be within the fixed MCP request limit");
  const maxInputFrameBytes =
    options.maxInputFrameBytes ?? MCP_MAX_INPUT_FRAME_BYTES;
  if (
    !Number.isSafeInteger(maxInputFrameBytes) ||
    maxInputFrameBytes <= 0 ||
    maxInputFrameBytes > MCP_MAX_INPUT_FRAME_BYTES
  )
    throw new Error(
      "maxInputFrameBytes must be within the fixed MCP input limit",
    );
  const decoder = new JsonLineDecoder(maxInputFrameBytes);
  const pending = new Set<Promise<void>>();
  let accepting = true;
  let inputEnded = false;
  let inputError: Error | undefined;
  let feedChain = Promise.resolve();
  let ordered = Promise.resolve();
  let diagnosticCount = 0;
  let settleClose!: () => void;
  let finalizing: Promise<void> | undefined;
  const lifecycle: {
    finishInput?: (withFinalFrame: boolean) => Promise<void>;
  } = {};
  const closed = new Promise<void>((resolve) => {
    settleClose = resolve;
  });

  const diagnostic = (record: Record<string, unknown>) => {
    if (diagnosticCount >= MCP_MAX_SIZE_DIAGNOSTICS) return;
    diagnosticCount++;
    try {
      options.onDiagnostic?.(boundedDiagnosticLine(record));
    } catch {
      // Diagnostics cannot affect protocol framing or accepted work.
    }
  };

  const stopInput = () => {
    if (!accepting) return;
    accepting = false;
    options.input.pause();
    options.input.destroy();
    decoder.discard();
    void lifecycle.finishInput?.(false);
  };

  const writer = new McpFrameWriter(options.output, {
    ...(options.externalize ? { externalize: options.externalize } : {}),
    ...(options.onOwnedResult ? { onOwnedResult: options.onOwnedResult } : {}),
    onOutputClosed: (error) => {
      if (
        error?.name !== "EPIPE" &&
        (error as (Error & { code?: string }) | undefined)?.code !== "EPIPE"
      )
        diagnostic({ event: "mcp_output_closed", code: "OUTPUT_CLOSED" });
      stopInput();
    },
  });

  const reportFrameError = async (error: unknown) => {
    diagnostic({ event: "mcp_frame_error", code: "FRAME_HANDLER_FAILED" });
    if (
      error instanceof Error &&
      (error as Error & { code?: string }).code === "EPIPE"
    )
      stopInput();
  };

  const admit = async (frame: InputFrame): Promise<void> => {
    if (frame.kind === "line" && !frame.text.trim()) return;
    while (pending.size >= pendingLimit && accepting) {
      const settled = await Promise.race(pending);
      void settled;
    }
    if (!accepting) return;

    let work: Promise<void>;
    const concurrent =
      frame.kind === "line" && (options.isConcurrent?.(frame.text) ?? false);
    if (concurrent) {
      work = Promise.resolve().then(() => options.handle(frame));
    } else {
      ordered = ordered
        .catch(() => undefined)
        .then(() => options.handle(frame));
      work = ordered;
    }
    const settledWork = work.catch(reportFrameError).finally(() => {
      pending.delete(settledWork);
    });
    pending.add(settledWork);
  };

  const onData = (chunk: Buffer | Uint8Array) => {
    options.input.pause();
    feedChain = feedChain
      .then(async () => {
        if (!accepting) return;
        await decoder.push(chunk, admit);
      })
      .catch((error: unknown) => {
        void reportFrameError(error);
        stopInput();
      })
      .then(() => {
        if (accepting) options.input.resume();
      });
  };

  const finish = (withFinalFrame: boolean) => {
    if (finalizing) return finalizing;
    options.input.pause();
    finalizing = feedChain
      .then(async () => {
        if (withFinalFrame && !inputError) await decoder.end(admit);
        else decoder.discard();
        accepting = false;
        await Promise.allSettled([...pending]);
        if (inputError)
          diagnostic({ event: "mcp_input_closed", code: "INPUT_ERROR" });
        settleClose();
      })
      .catch((error: unknown) => {
        void reportFrameError(error);
        settleClose();
      });
    return finalizing;
  };
  lifecycle.finishInput = finish;

  const onEnd = () => {
    inputEnded = true;
    void finish(true);
  };
  const onClose = () => {
    void finish(inputEnded);
  };
  const onError = (error: Error) => {
    inputError = error;
    stopInput();
    void finish(false);
  };

  options.input.on("data", onData);
  options.input.once("end", onEnd);
  options.input.once("close", onClose);
  options.input.once("error", onError);
  options.input.resume();

  return {
    closed,
    writer,
    get pendingRequests() {
      return pending.size;
    },
    close() {
      stopInput();
      void finish(false);
    },
  };
}

export function createStdioFrameHandler(
  writer: McpFrameWriter,
  post: (
    request: JsonRpcRequest,
    session?: string,
    version?: string,
  ) => Promise<McpResponse>,
  options: Omit<McpForwarderOptions, "sink">,
) {
  return createMcpProtocolForwarder(post, { ...options, sink: writer });
}

export function queueHelperRequest(line: string): boolean {
  try {
    const parsed = parseJsonRpcRequest(line);
    if (!("request" in parsed) || parsed.request.method !== "tools/call")
      return false;
    const params = parsed.request["params"];
    const name = isObject(params) ? params["name"] : undefined;
    return (
      typeof name === "string" &&
      name.startsWith("fmcad_queue_") &&
      name !== "fmcad_queue_begin"
    );
  } catch {
    return false;
  }
}
