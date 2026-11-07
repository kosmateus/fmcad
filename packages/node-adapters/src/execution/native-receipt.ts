import { lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

interface Binding {
  jobId: string;
  rpcId: string;
  requestHash: string;
  buildHash: string;
  sourceHash?: string;
}
export interface NativeRecord {
  receipt?: string;
  binding: Binding;
  instance: unknown;
}
export interface NativeProof extends Binding {
  instance: unknown;
  terminal: boolean;
  stage: string;
  outcome?: string;
  native?: {
    kind: string;
    identity: unknown;
    state?: {
      destroyed?: boolean;
      notStarted?: boolean;
      accepted?: boolean;
      createdCount?: number;
      executeCount?: number;
      completed?: boolean;
    };
  };
}
export interface NativeReceiptPorts {
  readJson(file: string): NativeProof;
  sameInstance(left: unknown, right: unknown): boolean;
  identity(value: { identity: unknown }): { kind: string } | null;
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "NATIVE_RECEIPT_MISMATCH" });
}

/** Receipt evidence only: terminal failed native work is settled, not success. */
export function createNativeReceipts(ports: NativeReceiptPorts) {
  function read(record: NativeRecord, suffix: string): NativeProof | null {
    if (!record.receipt) return null;
    const file = record.receipt + suffix;
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      fail("Native lifecycle receipt is not a bounded regular file");
    const value = ports.readJson(file);
    if (
      !(
        ["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"] as const
      ).every((key) => value[key] === record.binding[key]) ||
      !ports.sameInstance(value.instance, record.instance)
    )
      fail("Native receipt is not bound to the original RPC/build/instance");
    return value;
  }
  function start(record: NativeRecord): NativeProof | null {
    const value = read(record, ".native-start.json");
    if (!value) return null;
    const identified = ports.identity({ identity: value.native?.identity });
    if (
      value.terminal !== false ||
      value.stage !== "native-start" ||
      !identified ||
      value.native?.kind !== identified.kind
    ) {
      fail("Invalid native workflow declaration");
    }
    return value;
  }
  function completion(
    record: NativeRecord,
    declaration = start(record),
  ): NativeProof | null {
    if (!declaration) return null;
    const value = read(record, ".native-end.json");
    if (!value) return null;
    const state = value.native?.state;
    const ended =
      state?.destroyed === true ||
      (state?.notStarted === true &&
        state.accepted === false &&
        state.createdCount === 0 &&
        state.executeCount === 0);
    if (
      value.terminal !== true ||
      value.stage !== "native-completion" ||
      !ended ||
      value.native?.kind !== declaration.native?.kind ||
      !isDeepStrictEqual(
        value.native?.identity,
        declaration.native?.identity,
      ) ||
      value.outcome !== (state?.completed === true ? "succeeded" : "failed")
    ) {
      fail(
        "Native completion differs from its declared command or has no terminal lifecycle proof",
      );
    }
    return value;
  }
  return { start, completion };
}
