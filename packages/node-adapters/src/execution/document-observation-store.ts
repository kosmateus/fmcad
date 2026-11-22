import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { QueuePhysicalBinding } from "../../../core/src/domain/queue-model";
import { physicalBinding } from "../../../core/src/domain/queue-quarantine";
import {
  durableBytes,
  failure,
  MAX_JSON_RECORD_BYTES,
  readBytes,
  syncDirectory,
} from "../persistence/records";

/** Structural subset: the domain owns the observation codec and checkpoint CAS. */
export interface ObservationContext {
  id: string;
  requestId: string;
  actorClientId: string;
  target: { creationId?: string; fileId?: string };
  generation: string;
  scope: "parameters";
  stateDigest: string;
}
export interface ObservationReadback {
  reference: string;
  sha256: string;
  probeRequestId: string;
}
export interface ObservationSource {
  role: string;
  reference: string;
  sha256: string;
}
/** Private DTO, never decoded from a public unlock request. All artifacts are
 * relative to this queue's owned jobs/<jobId>/ directory. The producer verifier
 * may require additional roles (manifest, native lifecycle receipts, etc.). */
export interface ObservationProof {
  jobId: string;
  rpcId: string;
  probeRequestId: string;
  requestHash: string;
  buildHash: string;
  sourceHash: string;
  producerManifestHash: string;
  physicalTurn: QueuePhysicalBinding;
  artifacts: ObservationSource[];
}
export interface ObservationArtifact extends ObservationSource {
  bytes: Uint8Array;
  value: unknown;
}
export interface VerifiedDocumentRead {
  actorClientId: string;
  target: ObservationContext["target"];
  generation: string;
  stateDigest: string;
  probeRequestId: string;
  proof: ObservationProof;
}
export interface ObservationStoreOptions {
  directory: string;
  namespace: string;
  /** REQUIRED trusted composition port. It must derive this projection from
   * the actual stored response and original RPC, using the existing catalog,
   * native receipt and compiled-source verifiers. Require param.inspect,
   * includeModel=true, no parameter filters, exact actor/target, successful
   * response, physical generation and producer manifest. Hash equality alone
   * is NOT verification. No production default or boolean bypass exists here.
   * This adapter does not settle a job, release a turn or grant mutation rights. */
  verifyProducer(input: {
    context: ObservationContext;
    proof: ObservationProof;
    artifacts: readonly ObservationArtifact[];
  }): VerifiedDocumentRead;
  /** Private fault-injection seam; never sourced from a client request. */
  io?: typeof fs;
}
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 256;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function reject(message: string): never {
  return failure("CORRUPT_STATE", message);
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Immutable evidence only. Only snapshot-referenced records are restored; an
 * orphan after a failed snapshot commit has no authority and is never scanned. */
export function createDocumentObservationStore(
  options: ObservationStoreOptions,
) {
  const io = options.io ?? fs;
  const root = path.resolve(options.directory);
  if (!text(options.namespace) || typeof options.verifyProducer !== "function")
    reject(
      "Observation store requires a namespace and trusted producer verifier",
    );
  const uid = process.getuid?.();
  function privateNode(file: string, directory: boolean) {
    const stat = io.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid) ||
      (!directory && stat.nlink !== 1)
    )
      reject("Observation evidence must be private, owned and regular");
    return stat;
  }
  // Reject symlinked parents too, without imposing private permissions on /tmp.
  for (let current = root; ; current = path.dirname(current)) {
    if (
      !io.lstatSync(current).isDirectory() ||
      io.lstatSync(current).isSymbolicLink()
    )
      reject("Observation root has an indirect directory");
    if (current === path.dirname(current)) break;
  }
  const rootStat = privateNode(root, true);
  const rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
  const directory = path.join(root, "document-observations");
  try {
    io.mkdirSync(directory, { mode: 0o700 });
    syncDirectory(root, io);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directoryStat = privateNode(directory, true);
  const directoryIdentity = { dev: directoryStat.dev, ino: directoryStat.ino };
  function identity(stat: fs.Stats) {
    return { dev: stat.dev, ino: stat.ino };
  }
  function stableRoot() {
    if (
      io.realpathSync(root) !== root ||
      !isDeepStrictEqual(identity(privateNode(root, true)), rootIdentity) ||
      !isDeepStrictEqual(
        identity(privateNode(directory, true)),
        directoryIdentity,
      )
    )
      reject("Observation directory identity changed");
  }
  function resolve(reference: string) {
    if (
      !text(reference) ||
      reference.includes("\\") ||
      reference
        .split("/")
        .some(
          (part) =>
            !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
        )
    )
      reject("Invalid observation artifact reference");
    const file = path.join(root, reference);
    if (!file.startsWith(root + path.sep))
      reject("Observation artifact escaped its namespace");
    return file;
  }
  function read(reference: string) {
    stableRoot();
    const file = resolve(reference);
    const parents: { file: string; stat: fs.Stats }[] = [];
    for (
      let current = path.dirname(file);
      current !== root;
      current = path.dirname(current)
    ) {
      parents.push({ file: current, stat: privateNode(current, true) });
    }
    const before = privateNode(file, false);
    const bytes = readBytes(file, MAX_JSON_RECORD_BYTES, io, file);
    const after = privateNode(file, false);
    if (
      !isDeepStrictEqual(
        [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs],
        [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
      ) ||
      parents.some(
        (parent) =>
          !isDeepStrictEqual(
            identity(parent.stat),
            identity(privateNode(parent.file, true)),
          ),
      )
    )
      reject("Observation artifact changed while reading");
    stableRoot();
    return bytes;
  }
  function checkProof(proof: ObservationProof) {
    if (
      !proof ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(proof.jobId) ||
      !text(proof.rpcId) ||
      !text(proof.probeRequestId) ||
      ![
        proof.requestHash,
        proof.buildHash,
        proof.sourceHash,
        proof.producerManifestHash,
      ].every(digest) ||
      !physicalBinding(proof.physicalTurn) ||
      proof.physicalTurn.turnId !== proof.rpcId ||
      !Array.isArray(proof.artifacts) ||
      proof.artifacts.length < 3 ||
      proof.artifacts.length > 32
    )
      reject("Invalid observation producer proof");
    const roles = new Set<string>();
    const references = new Set<string>();
    for (const artifact of proof.artifacts) {
      if (
        !artifact ||
        !text(artifact.role) ||
        roles.has(artifact.role) ||
        !digest(artifact.sha256) ||
        !text(artifact.reference) ||
        !artifact.reference.startsWith(`jobs/${proof.jobId}/`) ||
        references.has(artifact.reference)
      )
        reject("Foreign or duplicate observation source");
      resolve(artifact.reference);
      roles.add(artifact.role);
      references.add(artifact.reference);
    }
    if (
      !["rpc", "response", "physical-intent"].every((role) => roles.has(role))
    )
      reject(
        "Observation proof lacks original RPC, response or physical intent",
      );
  }
  function verifySources(context: ObservationContext, proof: ObservationProof) {
    checkProof(proof);
    const artifacts = proof.artifacts.map((artifact) => {
      const bytes = read(artifact.reference);
      if (sha256(bytes) !== artifact.sha256)
        reject("Observation source bytes changed");
      return { ...artifact, bytes: Uint8Array.from(bytes), value: json(bytes) };
    });
    const verified = options.verifyProducer({
      context: clone(context),
      proof: clone(proof),
      artifacts,
    });
    if (
      !isDeepStrictEqual(verified, {
        actorClientId: context.actorClientId,
        target: context.target,
        generation: context.generation,
        stateDigest: context.stateDigest,
        probeRequestId: proof.probeRequestId,
        proof,
      })
    )
      reject("Readback is not bound to the exact producer and observation");
    // The trusted verifier can perform I/O. Refuse a source swap during it.
    for (const artifact of proof.artifacts)
      if (sha256(read(artifact.reference)) !== artifact.sha256)
        reject("Observation source changed during producer verification");
  }
  function referenceFor(context: ObservationContext) {
    if (!text(context.id)) reject("Invalid observation ID");
    return `document-observations/${sha256(context.id)}.json`;
  }
  function body(context: ObservationContext, proof: ObservationProof) {
    return {
      version: 1,
      namespace: options.namespace,
      root,
      rootIdentity,
      context,
      proof,
    };
  }
  return {
    persist(
      context: ObservationContext,
      proof: ObservationProof,
    ): ObservationReadback {
      // Snapshot caller-owned objects before invoking any external port.
      context = clone(context);
      proof = clone(proof);
      verifySources(context, proof);
      const reference = referenceFor(context);
      const bytes = Buffer.from(JSON.stringify(body(context, proof)), "utf8");
      if (bytes.length > MAX_JSON_RECORD_BYTES)
        reject("Observation exceeds size limit");
      const file = resolve(reference);
      stableRoot();
      // Pin the output directory, so a concurrent directory rename/symlink
      // substitution cannot redirect the temporary file or exclusive link.
      const fd = io.openSync(
        directory,
        io.constants.O_RDONLY |
          io.constants.O_DIRECTORY |
          io.constants.O_NOFOLLOW,
      );
      try {
        if (!isDeepStrictEqual(identity(io.fstatSync(fd)), directoryIdentity))
          reject("Observation output directory was replaced");
        const pinned =
          process.platform === "linux"
            ? `/proc/self/fd/${fd}/${path.basename(file)}`
            : file;
        try {
          durableBytes(pinned, bytes, true, io);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!read(reference).equals(bytes))
            reject("Immutable observation ID already contains different bytes");
          // Reassert durability after an earlier ambiguous publication.
          io.fsyncSync(fd);
        }
      } finally {
        io.closeSync(fd);
      }
      if (!read(reference).equals(bytes))
        reject("Observation publication changed");
      for (const artifact of proof.artifacts)
        if (sha256(read(artifact.reference)) !== artifact.sha256)
          reject("Observation source changed during publication");
      return {
        reference,
        sha256: sha256(bytes),
        probeRequestId: proof.probeRequestId,
      };
    },
    verify(
      observation: ObservationContext & { readback: ObservationReadback },
    ): void {
      const { readback, ...context } = clone(observation);
      if (
        !readback ||
        readback.reference !== referenceFor(context) ||
        !digest(readback.sha256) ||
        !text(readback.probeRequestId)
      )
        reject("Invalid observation readback reference");
      const bytes = read(readback.reference);
      if (sha256(bytes) !== readback.sha256)
        reject("Observation record changed");
      const record = json(bytes) as { proof: ObservationProof };
      if (
        !record ||
        !isDeepStrictEqual(record, body(context, record.proof)) ||
        record.proof?.probeRequestId !== readback.probeRequestId
      )
        reject("Observation record belongs to another context or namespace");
      verifySources(context, record.proof);
      if (!read(readback.reference).equals(bytes))
        reject("Observation changed during restore");
    },
  };
}
