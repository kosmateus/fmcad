import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type {
  ArtifactId,
  ProjectId,
  RequestContext,
} from "../../../core/src/domain/contracts.js";
import type { OwnedResultReference } from "../../../core/src/ports/execution-store.js";
import { createArtifactStore } from "../persistence/artifact-store.js";
import {
  projectDirectory,
  regularDirectory,
} from "../persistence/owned-results.js";

type ArtifactKind =
  | "original-source"
  | "sent-source"
  | "current-file"
  | "response"
  | "stdout"
  | "stderr"
  | "rpc"
  | "event";
type ArtifactState =
  | "available"
  | "empty"
  | "missing"
  | "truncated"
  | "expired"
  | "error"
  | "forbidden";
interface ArtifactStoreContext {
  clientId: string;
  requestId: string;
  sessionId: string | null;
  projectId: string;
  documentId: string;
  instanceId: string | null;
  purpose: string | null;
}
const MAX_RANGE_BYTES = 2 * 1024 * 1024;
const MAX_OFFSET_BYTES = 64 * 1024 * 1024;
const MAX_OWNED_RESULT_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_STORE_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_EVENT_BYTES = 256 * 1024;
const MAX_HASHED_PROJECT_FILE_BYTES = 128 * 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const OUTPUT_NAMES = new Set(["stdout.txt", "stderr.txt", "rpc-result.json"]);

class ArtifactReadError extends Error {
  constructor(
    readonly state: "forbidden" | "error" | "missing" | "expired",
    message: string,
  ) {
    super(message);
  }
}

interface ConsoleArtifactReaderConfig {
  /** Must resolve only IDs authorized by the server-side project registry. */
  projectRoot(projectId: string): string | null;
  /** Existing private queue root used by OwnedResultReference resolution. */
  queueDirectory: string;
}

interface ArtifactIdentityLike {
  readonly projectId: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly locator?: ArtifactStorage;
}

interface ArtifactRequestLike {
  readonly version: number;
  readonly scope: { readonly kind: "project"; readonly projectId: string };
  readonly taskId: string;
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly snapshotToken: string;
  readonly offset?: number;
  readonly length?: number;
}

interface ArtifactReadResult {
  state: ArtifactState;
  content: string | null;
  offset: number;
  length: number;
  totalLength: number | null;
  reason?: string;
}

type ArtifactStorage =
  | {
      type: "project-file";
      path: string;
      bytes?: number | null;
      sha256: string | null;
    }
  | {
      type: "owned-result";
      reference: OwnedResultReference;
    }
  | { type: "artifact-store"; context: ArtifactStoreContext; sha256: string }
  | { type: "inline-event"; content: string }
  | { type: "missing" | "expired" | "error" | "forbidden" };

export type ConsoleArtifactLocator = ArtifactStorage;

export type ConsoleArtifactReaderOptions = ConsoleArtifactReaderConfig;

interface BoundedText {
  content: string | null;
  offset: number;
  length: number;
  totalLength: number;
  state: "available" | "empty" | "truncated";
}

function boundedId(value: unknown, max = 512): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}

function fail(
  state: "forbidden" | "error" | "missing" | "expired",
  message: string,
): never {
  throw new ArtifactReadError(state, message);
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function canonicalDirectory(rootPath: string): string {
  if (!path.isAbsolute(rootPath))
    fail("forbidden", "Owned root must be an absolute path.");
  try {
    const stat = fs.lstatSync(rootPath);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("forbidden", "Owned root must be a regular directory.");
    const root = fs.realpathSync(rootPath);
    if (root !== path.resolve(rootPath))
      fail("forbidden", "Owned root must be canonical.");
    return root;
  } catch (error) {
    if (error instanceof ArtifactReadError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      fail("forbidden", "Owned root is unavailable.");
    throw error;
  }
}

function textRange(
  buffer: Buffer,
  baseOffset: number,
  requestedOffset: number,
  requestedLength: number,
  totalLength: number,
): BoundedText {
  let start = Math.min(
    buffer.length,
    Math.max(0, requestedOffset - baseOffset),
  );
  let end = Math.min(
    buffer.length,
    Math.max(0, requestedOffset - baseOffset + requestedLength),
  );
  if (end < start) end = start;
  let skipped = 0;
  while (start < end && isContinuation(buffer[start]) && skipped < 3) {
    start++;
    skipped++;
  }
  if (start >= end) {
    if (requestedLength > 0 && requestedOffset < totalLength)
      fail(
        "error",
        "Requested range is too short for the next UTF-8 code point.",
      );
    const offset = baseOffset + start;
    return {
      content: "",
      offset,
      length: 0,
      totalLength,
      state: offset < totalLength ? "truncated" : "empty",
    };
  }
  if (start < buffer.length && isContinuation(buffer[start]))
    fail("error", "Requested byte offset splits a UTF-8 code point.");
  if (end < buffer.length && isContinuation(buffer[end])) {
    let lead = end - 1;
    while (lead > start && isContinuation(buffer[lead])) lead--;
    end = lead;
  }
  if (end < start) end = start;

  const bytes = buffer.subarray(start, end);
  if (
    bytes.length === 0 &&
    requestedLength > 0 &&
    requestedOffset < totalLength
  )
    fail(
      "error",
      "Requested range is too short for the next UTF-8 code point.",
    );
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("error", "Artifact range is not valid UTF-8 text.");
  }
  const offset = baseOffset + start;
  const length = bytes.length;
  return {
    content,
    offset,
    length,
    totalLength,
    state:
      length === 0
        ? offset < totalLength
          ? "truncated"
          : "empty"
        : offset + length < totalLength
          ? "truncated"
          : "available",
  };
}

function validateReference(
  reference: ArtifactIdentityLike,
  request: ArtifactRequestLike,
): void {
  if (
    request.version !== 1 ||
    request.scope?.kind !== "project" ||
    reference.projectId !== request.scope.projectId ||
    reference.taskId !== request.taskId ||
    reference.artifactId !== request.artifactId ||
    reference.kind !== request.kind ||
    ![
      "original-source",
      "sent-source",
      "current-file",
      "response",
      "stdout",
      "stderr",
      "rpc",
      "event",
    ].includes(reference.kind)
  )
    fail("forbidden", "Artifact does not match the retained owner.");
  if (
    !boundedId(reference.projectId, 256) ||
    !boundedId(reference.taskId, 256) ||
    !boundedId(reference.artifactId, 256) ||
    !boundedId(request.snapshotToken, 128)
  )
    fail("forbidden", "Artifact owner identity is invalid.");
  if (
    !Number.isSafeInteger(request.offset ?? 0) ||
    (request.offset ?? 0) < 0 ||
    (request.offset ?? 0) > MAX_OFFSET_BYTES ||
    !Number.isSafeInteger(request.length ?? 64 * 1024) ||
    (request.length ?? 64 * 1024) < 1 ||
    (request.length ?? 64 * 1024) > MAX_RANGE_BYTES
  )
    fail("error", "Artifact range exceeds the configured read limit.");
}

function resolveProjectFile(rootPath: string, sourcePath: string): string {
  if (!path.isAbsolute(rootPath) || !boundedId(sourcePath, 4096))
    fail("forbidden", "Artifact path is invalid.");
  if (sourcePath.split(/[\\/]/u).includes(".."))
    fail("forbidden", "Artifact path traversal is not allowed.");

  const root = canonicalDirectory(rootPath);

  const candidate = path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(root, sourcePath);
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    fail("forbidden", "Artifact escaped the registered project root.");

  let current = root;
  const components = relative.split(path.sep);
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]!);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink())
        fail("forbidden", "Symlinked artifact paths are not allowed.");
      if (index < components.length - 1 && !stat.isDirectory())
        fail("forbidden", "Artifact path component is not a directory.");
      if (index === components.length - 1 && !stat.isFile())
        fail("error", "Artifact source is not a regular file.");
    } catch (error) {
      if (error instanceof ArtifactReadError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail("missing", "Artifact source is missing.");
      throw error;
    }
  }
  return candidate;
}

function rangeFromBytes(
  bytes: Uint8Array,
  request: ArtifactRequestLike,
): BoundedText {
  const buffer = Buffer.from(bytes);
  const offset = request.offset ?? 0;
  const length = request.length ?? 64 * 1024;
  return textRange(buffer, 0, offset, length, buffer.length);
}

/** Range read with streaming whole-file digest verification when supplied. */
async function readProjectFileRange(
  file: string,
  offset: number,
  length: number,
  expectedHash: string,
  expectedBytes: number | null,
): Promise<BoundedText> {
  if (!HASH.test(expectedHash))
    fail("error", "Retained artifact digest is invalid.");
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      fail("error", "Artifact source is not a regular file.");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
      fail("error", "Artifact size exceeds the safe range limit.");
    const totalLength = Number(before.size);
    if (
      expectedBytes !== null &&
      (!Number.isSafeInteger(expectedBytes) || expectedBytes !== totalLength)
    )
      fail("error", "Retained artifact size does not match.");
    const windowStart = Math.min(offset, totalLength);
    const windowEnd = Math.min(totalLength, offset + length + 3);
    const window = Buffer.alloc(windowEnd - windowStart);

    if (totalLength > MAX_HASHED_PROJECT_FILE_BYTES)
      fail("error", "Artifact exceeds the bounded digest verification limit.");
    const hash = createHash("sha256");
    const block = Buffer.alloc(READ_BLOCK_BYTES);
    let position = 0;
    while (position < totalLength) {
      const read = await handle.read(
        block,
        0,
        Math.min(block.length, totalLength - position),
        position,
      );
      if (!read.bytesRead) fail("error", "Artifact changed while reading.");
      const chunk = block.subarray(0, read.bytesRead);
      hash.update(chunk);
      const from = Math.max(position, windowStart);
      const to = Math.min(position + read.bytesRead, windowEnd);
      if (to > from)
        chunk.copy(window, from - windowStart, from - position, to - position);
      position += read.bytesRead;
    }
    if (hash.digest("hex") !== expectedHash)
      fail("error", "Retained artifact digest does not match.");

    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      fail("error", "Artifact changed while reading.");
    const openedPath =
      process.platform === "linux"
        ? fs.realpathSync(`/proc/self/fd/${handle.fd}`)
        : fs.realpathSync(file);
    if (openedPath !== file)
      fail("forbidden", "Opened artifact escaped the verified project path.");
    return textRange(window, windowStart, offset, length, totalLength);
  } catch (error) {
    if (error instanceof ArtifactReadError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      fail("missing", "Artifact source is missing.");
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      fail("forbidden", "Symlinked artifact paths are not allowed.");
    throw error;
  } finally {
    await handle?.close();
  }
}

function resolveOwnedResultFile(
  queueDirectory: string,
  projectRoot: string,
  taskId: string,
  reference: OwnedResultReference,
): string {
  if (
    reference.version !== 1 ||
    Object.keys(reference).sort().join(",") !==
      "bytes,jobId,name,scope,sha256,storage,version" ||
    reference.jobId !== taskId ||
    !OUTPUT_NAMES.has(reference.name) ||
    !["project", "legacy"].includes(reference.storage) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0 ||
    reference.bytes > MAX_OWNED_RESULT_BYTES ||
    !HASH.test(reference.sha256) ||
    !HASH.test(reference.scope)
  )
    fail("forbidden", "Owned result does not match its retained task.");

  const registeredRoot = canonicalDirectory(projectRoot);
  const project = projectDirectory(registeredRoot);
  if (project !== registeredRoot)
    fail("forbidden", "Task project root does not match the registry.");
  const queueRoot = canonicalDirectory(queueDirectory);
  const expectedScope = createHash("sha256").update(project).digest("hex");
  if (reference.scope !== expectedScope)
    fail("forbidden", "Owned result scope does not match its project.");

  const directory =
    reference.storage === "project"
      ? regularDirectory(project, [".cad", "results", taskId])
      : regularDirectory(queueRoot, ["jobs", taskId]);
  return resolveProjectFile(directory, reference.name);
}

function asRead(result: BoundedText): ArtifactReadResult {
  return {
    state: result.state,
    content: result.content,
    offset: result.offset,
    length: result.length,
    totalLength: result.totalLength,
  };
}

export function createConsoleArtifactReader(
  options: ConsoleArtifactReaderOptions,
) {
  if (!path.isAbsolute(options.queueDirectory))
    throw new Error("Console artifact queue directory must be absolute");

  return {
    async readArtifact<
      TReference extends ArtifactIdentityLike,
      TRequest extends ArtifactRequestLike,
    >(reference: TReference, request: TRequest): Promise<ArtifactReadResult> {
      try {
        validateReference(reference, request);
        const rootPath = options.projectRoot(reference.projectId);
        if (!rootPath)
          fail("forbidden", "Project is not present in the owned registry.");
        const root = canonicalDirectory(rootPath);
        const locator = reference.locator;
        if (!locator)
          return {
            state: "missing",
            content: null,
            offset: request.offset ?? 0,
            length: 0,
            totalLength: null,
          };
        if (
          locator.type === "missing" ||
          locator.type === "expired" ||
          locator.type === "error" ||
          locator.type === "forbidden"
        )
          return {
            state: locator.type,
            content: null,
            offset: request.offset ?? 0,
            length: 0,
            totalLength: null,
          };

        if (locator.type === "inline-event") {
          if (reference.kind !== "event")
            fail(
              "forbidden",
              "Inline event content is not valid for this artifact kind.",
            );
          const bytes = Buffer.from(locator.content, "utf8");
          if (bytes.length > MAX_INLINE_EVENT_BYTES)
            fail("error", "Inline event exceeds the bounded content limit.");
          return asRead(rangeFromBytes(bytes, request));
        }

        if (locator.type === "artifact-store") {
          if (
            !HASH.test(locator.sha256) ||
            Object.keys(locator.context).sort().join(",") !==
              "clientId,documentId,instanceId,projectId,purpose,requestId,sessionId" ||
            locator.context.projectId !== reference.projectId ||
            !boundedId(locator.context.documentId, 256) ||
            !boundedId(locator.context.clientId, 256) ||
            !boundedId(locator.context.requestId, 256) ||
            (locator.context.sessionId !== null &&
              !boundedId(locator.context.sessionId, 256)) ||
            (locator.context.instanceId !== null &&
              !boundedId(locator.context.instanceId, 256)) ||
            (locator.context.purpose !== null &&
              !boundedId(locator.context.purpose, 128))
          )
            fail("forbidden", "Artifact document binding is invalid.");
          const store = createArtifactStore(root);
          const context: RequestContext = {
            ...locator.context,
            version: 1,
            clientId: locator.context.clientId as RequestContext["clientId"],
            requestId: locator.context.requestId as RequestContext["requestId"],
            sessionId: locator.context.sessionId as RequestContext["sessionId"],
            projectId: locator.context.projectId as ProjectId,
            documentId: locator.context
              .documentId as RequestContext["documentId"],
            instanceId: locator.context
              .instanceId as RequestContext["instanceId"],
          };
          const content = await store.read(
            context,
            reference.artifactId as ArtifactId,
          );
          if (content === null)
            return {
              state: "missing",
              content: null,
              offset: request.offset ?? 0,
              length: 0,
              totalLength: null,
            };
          if (
            createHash("sha256").update(content, "utf8").digest("hex") !==
            locator.sha256
          )
            fail("error", "Retained ArtifactStore hash does not match.");
          const bytes = Buffer.from(content, "utf8");
          if (bytes.length > MAX_ARTIFACT_STORE_BYTES)
            fail("error", "Artifact store returned an oversized object.");
          return asRead(rangeFromBytes(bytes, request));
        }

        if (locator.type === "owned-result") {
          if (!["response", "stdout", "stderr", "rpc"].includes(reference.kind))
            fail("forbidden", "Owned execution output kind is invalid.");
          if (!/^[A-Za-z0-9_-]{1,256}$/u.test(reference.taskId))
            fail("forbidden", "Owned result task ID is invalid.");
          // Preserve the owned-result descriptor checks while streaming the requested bytes.
          const owned = locator.reference as OwnedResultReference;
          const expectedOutputName =
            reference.kind === "stdout"
              ? "stdout.txt"
              : reference.kind === "stderr"
                ? "stderr.txt"
                : reference.kind === "rpc"
                  ? "rpc-result.json"
                  : null;
          if (expectedOutputName && owned.name !== expectedOutputName)
            fail("forbidden", "Owned result name does not match its channel.");
          const file = resolveOwnedResultFile(
            options.queueDirectory,
            root,
            reference.taskId,
            owned,
          );
          return asRead(
            await readProjectFileRange(
              file,
              request.offset ?? 0,
              request.length ?? 64 * 1024,
              owned.sha256,
              owned.bytes,
            ),
          );
        }

        if (locator.type === "project-file") {
          const expectedOutputName =
            reference.kind === "stdout"
              ? "stdout.txt"
              : reference.kind === "stderr"
                ? "stderr.txt"
                : reference.kind === "rpc"
                  ? "rpc-result.json"
                  : null;
          if (
            expectedOutputName &&
            path.basename(locator.path) !== expectedOutputName
          )
            fail(
              "forbidden",
              "Project file does not match its output channel.",
            );
          const file = resolveProjectFile(root, locator.path);
          if (locator.sha256 === null)
            fail(
              "error",
              "Retained project file has no verifiable content hash.",
            );
          return asRead(
            await readProjectFileRange(
              file,
              request.offset ?? 0,
              request.length ?? 64 * 1024,
              locator.sha256,
              locator.bytes ?? null,
            ),
          );
        }
        fail("error", "Unsupported artifact storage locator.");
      } catch (error) {
        if (error instanceof ArtifactReadError)
          return {
            state: error.state,
            content: null,
            offset: request.offset ?? 0,
            length: 0,
            totalLength: null,
            reason: error.message,
          };
        const code = (error as NodeJS.ErrnoException).code;
        return {
          state:
            code === "ENOENT"
              ? "missing"
              : code === "INVALID_ARTIFACT" || code === "ELOOP"
                ? "forbidden"
                : "error",
          content: null,
          offset: request.offset ?? 0,
          length: 0,
          totalLength: null,
          reason: "Artifact read failed.",
        };
      }
    },
  };
}
