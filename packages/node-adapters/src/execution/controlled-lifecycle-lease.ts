import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ControlledProcess } from "./controlled-fusion-launch-types";

/**
 * Private operator composition only. These are live ports, not assertions
 * decoded from a request or from the reset marker.
 */
export interface ControlledLifecyclePorts {
  readonly directory: string;
  readonly operator: ControlledProcess;
  readonly old: ControlledProcess;
  readonly buildHash: string;
  /** Exact current operator owner/revocation check; must return undefined. */
  fence(): void;
  /** Check accepted producers/turns, not merely the absence of a foreground job. */
  assertQuiescent(): Promise<void>;
  /** ONE supported fenced broker stop; verify original release and OS death. */
  stopBrokerOnce(): Promise<void>;
  /** Recheck that no broker/producer has acquired ingress after the stop. */
  assertIngressHeld(): Promise<void>;
  /** Exact PID/birth native WM_CLOSE and bounded normal-death observation. */
  retireOldNormally(old: ControlledProcess): Promise<void>;
}

function sync(fence: () => void): void {
  const result: unknown = fence();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Controlled lifecycle fence must be synchronous");
  }
}

/**
 * Hold the existing broker's fusion-reset.lock submission/autostart barrier
 * across the controller, native publication and subsequent host preparation.
 * This does not settle jobs, grant SDK admission, or prove native host closure.
 * There is deliberately no automatic marker removal or recovery/retry path.
 */
export function createControlledLifecycleLease(
  ports: ControlledLifecyclePorts,
) {
  const directory = path.resolve(ports.directory);
  if (fs.realpathSync(directory) !== directory)
    throw new Error("Canonical existing queue directory required");
  const owner = Object.freeze({ ...ports.operator });
  const old = Object.freeze({ ...ports.old });
  for (const value of [owner, old]) {
    if (
      Object.keys(value).sort().join() !== "birth,pid" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !/^[0-9]+$/.test(value.birth)
    )
      throw new Error("Exact lifecycle process identity required");
  }
  const buildHash = ports.buildHash;
  if (!/^[a-f0-9]{64}$/.test(buildHash))
    throw new Error("Pinned broker build required");
  // Capture methods, not the mutable options object.
  const {
    fence: operatorFence,
    assertQuiescent,
    stopBrokerOnce,
    assertIngressHeld,
    retireOldNormally,
  } = ports;
  const file = path.join(directory, "fusion-reset.lock");
  let invoked = false;
  let revoked = false;
  let descriptor: number | undefined;
  let original: fs.BigIntStats | undefined;
  let expected: Buffer | undefined;
  let retirementStarted = false;

  function fence(): void {
    try {
      if (revoked || descriptor === undefined || !original || !expected)
        throw new Error("Controlled lifecycle lease is not held");
      sync(operatorFence);
      const held = fs.fstatSync(descriptor, { bigint: true });
      const named = fs.lstatSync(file, { bigint: true });
      for (const current of [held, named]) {
        if (
          !current.isFile() ||
          current.nlink !== 1n ||
          [
            "dev",
            "ino",
            "mode",
            "uid",
            "gid",
            "size",
            "mtimeNs",
            "ctimeNs",
          ].some(
            (key) =>
              current[key as keyof fs.BigIntStats] !==
              original![key as keyof fs.BigIntStats],
          )
        )
          throw new Error("Original lifecycle barrier identity changed");
      }
      const bytes = Buffer.alloc(expected.length + 1);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (
        length !== expected.length ||
        !bytes.subarray(0, length).equals(expected)
      )
        throw new Error("Original lifecycle barrier bytes changed");
      sync(operatorFence);
    } catch (error) {
      revoked = true;
      throw error;
    }
  }
  async function assertCurrent(): Promise<void> {
    fence();
    try {
      await assertIngressHeld();
      fence();
    } catch (error) {
      revoked = true;
      throw error;
    }
  }
  return Object.freeze({
    async acquireExclusiveLifecycleLease() {
      if (invoked) throw new Error("Lifecycle acquisition is single-use");
      invoked = true;
      sync(operatorFence);
      const bytes = Buffer.from(
        JSON.stringify({
          protocol: 1,
          pid: owner.pid,
          birth: owner.birth,
          nonce: randomUUID(),
          buildHash,
          fusion: old,
          resetPause: null,
          phase: "controlled-bootstrap-held",
          at: new Date().toISOString(),
        }) + "\n",
      );
      // Existing markers, symlinks and uncertain previous attempts are refused.
      descriptor = fs.openSync(
        file,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_RDWR |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
        const parent = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(parent);
        } finally {
          fs.closeSync(parent);
        }
        original = fs.fstatSync(descriptor, { bigint: true });
        expected = bytes;
        fence();
        await assertQuiescent();
        fence();
        await stopBrokerOnce();
        fence();
        await assertCurrent();
        return Object.freeze({
          fence,
          assertCurrent,
          async retireOldNormally(value: ControlledProcess) {
            await assertCurrent();
            if (
              retirementStarted ||
              value.pid !== old.pid ||
              value.birth !== old.birth
            )
              throw new Error("Exact original single retirement required");
            retirementStarted = true;
            try {
              await retireOldNormally(old);
              await assertCurrent();
            } catch (error) {
              revoked = true;
              throw error;
            }
          },
        });
      } catch (error) {
        revoked = true;
        // Retain original barrier and evidence even after an uncertain stop.
        fs.closeSync(descriptor);
        descriptor = undefined;
        throw error;
      }
    },
  });
}
