import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { admissionData, decodeAdmissionJson } from "./admission-json";
import {
  createPhysicalTurnStatusRequest,
  type PhysicalTurnStatusRequest,
} from "./admission-http";
import type { Spawn } from "../fusion-transport/contracts";

export interface PhysicalGenerationDescriptor {
  kind: "fmcad-physical-grant";
  version: 1;
  handoffId: string;
  generation: { instance: string; epoch: string };
  brokerOwner: {
    pid: number;
    birth: string;
    nonce: string;
    clientId: string;
    queueDirectory: string;
  };
  endpointURL: string;
  physicalRuntime: {
    pid: number;
    birth: string;
    version: string;
    source: string;
    build: string;
  };
}

export interface PhysicalTurnBinding {
  version: 1;
  grantDigest: string;
  generation: PhysicalGenerationDescriptor["generation"];
  physicalRuntime: PhysicalGenerationDescriptor["physicalRuntime"];
  turnId: string;
  target: string;
}
export type PhysicalTurnQuiescence =
  | { state: "unknown" | "active"; binding: PhysicalTurnBinding }
  | {
      state: "released";
      binding: PhysicalTurnBinding;
      physicalEvidenceReference: string;
      evidenceDigest: string;
    };

function denied(): never {
  throw Object.assign(
    new Error("Physical generation authorization is unavailable"),
    {
      code: "PHYSICAL_GENERATION_REJECTED",
      notStarted: true,
    },
  );
}
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Exact Python AdmissionStore._encode projection: sorted ASCII keys, compact
 * separators and ensure_ascii=True. Target remains an opaque exact string. */
function releasedDigest(
  binding: PhysicalTurnBinding,
  releasedBy: string,
): string {
  const { physicalRuntime: runtime, generation } = binding;
  const encoded = JSON.stringify({
    binding: {
      generation: { epoch: generation.epoch, instance: generation.instance },
      grantDigest: binding.grantDigest,
      physicalRuntime: {
        birth: runtime.birth,
        build: runtime.build,
        pid: runtime.pid,
        source: runtime.source,
        version: runtime.version,
      },
      target: binding.target,
      turnId: binding.turnId,
      version: binding.version,
    },
    releasedBy,
    state: "released",
  }).replace(
    /[\u007f-\uffff]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

/** Only the trusted broker composition constructs this capability. Neither its
 * descriptor nor the grant path is taken from a public request/admission DTO. */
export function createPhysicalGenerationAuthorization(
  options: {
    grantFile: string;
    grantDigest: string;
    expected: PhysicalGenerationDescriptor;
    /** Captured from the claimed broker lifetime, never supplied by a public client. */
    assertBrokerOwner(): void;
    transport?: "node" | "windows-curl";
    timeoutMs?: number;
  },
  dependencies: {
    spawn?: Spawn;
    /** Private test/transport seam, never a request-controlled capability. */
    request?: PhysicalTurnStatusRequest;
  } = {},
) {
  const expected = structuredClone(options.expected);
  const grantFile = options.grantFile;
  const grantDigest = options.grantDigest;
  if (
    !/^[a-f0-9]{64}$/.test(grantDigest) ||
    !path.isAbsolute(grantFile) ||
    path.normalize(grantFile) !== grantFile
  )
    denied();
  const base = new URL(expected.endpointURL);
  if (
    base.protocol !== "http:" ||
    base.port !== "8765" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.pathname !== "/mcp" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    denied();
  if (
    (options.transport !== undefined &&
      !["node", "windows-curl"].includes(options.transport)) ||
    expected.kind !== "fmcad-physical-grant" ||
    expected.version !== 1 ||
    !expected.handoffId ||
    !expected.generation.instance ||
    !expected.generation.epoch ||
    !Number.isSafeInteger(expected.brokerOwner.pid) ||
    expected.brokerOwner.pid <= 0 ||
    !Number.isSafeInteger(expected.physicalRuntime.pid) ||
    expected.physicalRuntime.pid <= 0 ||
    !path.isAbsolute(expected.brokerOwner.queueDirectory) ||
    [
      expected.brokerOwner.birth,
      expected.brokerOwner.nonce,
      expected.brokerOwner.clientId,
      expected.physicalRuntime.birth,
      expected.physicalRuntime.version,
      expected.physicalRuntime.source,
      expected.physicalRuntime.build,
    ].some((value) => typeof value !== "string" || !value)
  )
    denied();
  const uid = process.getuid?.();
  const scope = new AsyncLocalStorage<PhysicalTurnBinding>();
  function token(): string {
    let fd: number | undefined;
    try {
      options.assertBrokerOwner();
      const parent = path.dirname(grantFile);
      if (
        fs.realpathSync(parent) !== parent ||
        fs.realpathSync(grantFile) !== grantFile
      )
        denied();
      const directory = fs.statSync(parent);
      if (
        uid === undefined ||
        directory.uid !== uid ||
        (directory.mode & 0o077) !== 0
      )
        denied();
      fd = fs.openSync(
        grantFile,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const before = fs.fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(uid) ||
        (before.mode & 0o077n) !== 0n ||
        before.size > 16384n
      )
        denied();
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(grantFile, { bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
        if (before[key] !== after[key] || before[key] !== current[key])
          denied();
      if (
        current.isSymbolicLink() ||
        createHash("sha256").update(bytes).digest("hex") !== grantDigest
      )
        denied();
      const value: unknown = decodeAdmissionJson(utf8.decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) denied();
      const { token: privateToken, ...descriptor } = value as Record<
        string,
        unknown
      >;
      if (
        typeof privateToken !== "string" ||
        !/^[\x21-\x7e]{32,}$/.test(privateToken) ||
        !isDeepStrictEqual(descriptor, expected)
      )
        denied();
      return privateToken;
    } catch {
      return denied();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  function turnBinding(turnId: string, target: string): PhysicalTurnBinding {
    if (
      !/^[\x21-\x7e]{1,256}$/.test(turnId) ||
      typeof target !== "string" ||
      !target
    )
      denied();
    return structuredClone({
      version: 1,
      grantDigest,
      generation: expected.generation,
      physicalRuntime: expected.physicalRuntime,
      turnId,
      target,
    });
  }
  function headers(
    endpoint: string,
    turn?: { turnId: string; target: string },
  ) {
    const scoped = scope.getStore();
    if (
      turn &&
      scoped &&
      (turn.turnId !== scoped.turnId || turn.target !== scoped.target)
    )
      denied();
    turn ??= scoped;
    const destination = new URL(endpoint);
    if (
      destination.origin !== base.origin ||
      destination.search ||
      destination.hash ||
      destination.username ||
      destination.password ||
      !["/mcp", "/admission/v1", "/physical/v1/turn-status"].includes(
        destination.pathname,
      )
    )
      denied();
    const result: Record<string, string> = {
      "X-Fmcad-Physical-Grant": token(),
    };
    if (turn) {
      turnBinding(turn.turnId, turn.target);
      result["X-Fmcad-Physical-Turn"] = turn.turnId;
      result["X-Fmcad-Physical-Target"] = Buffer.from(
        turn.target,
        "utf8",
      ).toString("base64url");
    }
    return result;
  }
  function withPhysicalTurn<T>(
    binding: PhysicalTurnBinding,
    action: () => T,
  ): T {
    if (
      !isDeepStrictEqual(binding, turnBinding(binding.turnId, binding.target))
    )
      denied();
    const immutable = Object.freeze(structuredClone(binding));
    return scope.run(immutable, action);
  }
  async function physicalTurnQuiescence(
    binding: PhysicalTurnBinding,
  ): Promise<PhysicalTurnQuiescence> {
    const original = structuredClone(binding);
    const unknown = (): PhysicalTurnQuiescence => ({
      state: "unknown",
      binding: original,
    });
    if (
      !isDeepStrictEqual(binding, turnBinding(binding.turnId, binding.target))
    )
      return unknown();
    const endpoint = new URL("/physical/v1/turn-status", base).href;
    try {
      const request =
        dependencies.request ??
        createPhysicalTurnStatusRequest(
          { transport: options.transport },
          { spawn: dependencies.spawn },
        );
      const response = await request({
        endpoint,
        headers: headers(endpoint),
        body: Buffer.from(JSON.stringify(original), "utf8"),
        timeoutMs: options.timeoutMs ?? 10000,
      });
      if (response.status !== 200) return unknown();
      const value: unknown = decodeAdmissionJson(utf8.decode(response.body));
      if (!value || typeof value !== "object" || Array.isArray(value))
        return unknown();
      const proof = value as Record<string, unknown>;
      if (!isDeepStrictEqual(proof["binding"], original)) return unknown();
      if (proof["state"] === "active" || proof["state"] === "unknown") {
        if (Object.keys(proof).sort().join(",") !== "binding,state")
          return unknown();
        return { state: proof["state"], binding: original };
      }
      const evidence = proof["evidenceDigest"];
      if (
        proof["state"] !== "released" ||
        typeof evidence !== "string" ||
        !["dispatch-finally", "cancelled-before-sdk"].some(
          (reason) => releasedDigest(original, reason) === evidence,
        ) ||
        proof["physicalEvidenceReference"] !==
          `fmcad-physical-turn:sha256:${evidence}` ||
        Object.keys(proof).sort().join(",") !==
          "binding,evidenceDigest,physicalEvidenceReference,state"
      )
        return unknown();
      return {
        state: "released",
        binding: original,
        evidenceDigest: evidence,
        physicalEvidenceReference: `fmcad-physical-turn:sha256:${evidence}`,
      };
    } catch {
      return unknown();
    }
  }
  function bindPhysicalTurn(local: {
    physicalRequestId: string;
    documentSelector?: object | null;
    kind?: string;
    brokerNonce?: string;
  }): PhysicalTurnBinding {
    if (
      local.kind === "system-read" &&
      local.brokerNonce !== expected.brokerOwner.nonce
    )
      denied();
    token();
    const selector = admissionData(local.documentSelector ?? null);
    if (
      selector !== null &&
      (typeof selector !== "object" || Array.isArray(selector))
    )
      denied();
    const target =
      selector === null
        ? "null"
        : JSON.stringify(
            Object.fromEntries(
              Object.entries(selector).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            ),
          );
    return turnBinding(local.physicalRequestId, target);
  }
  return {
    headers,
    turnBinding,
    bindPhysicalTurn,
    withPhysicalTurn,
    physicalTurnQuiescence,
  };
}
