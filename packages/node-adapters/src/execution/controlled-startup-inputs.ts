import { createHash } from "node:crypto";
import type {
  ControlledFile,
  ControlledNativeAdapter,
} from "./controlled-fusion-launch-types";
import {
  assertControlledPythonAutorunData,
  type StartupPolicyExpected,
} from "./controlled-startup-policy";

declare const inputsBrand: unique symbol;
/** Private original OS-input witness. Never an SDK or dispatch capability. */
export interface ControlledStartupInputs {
  readonly [inputsBrand]: true;
}
interface Original {
  expected: StartupPolicyExpected;
  files: readonly ControlledFile[];
  check(): void;
  verify(): Promise<void>;
}
const originals = new WeakMap<object, Original>();
function deny(): never {
  throw new Error("Original held startup input witness required");
}
function synchronous(check: () => void) {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    deny();
  }
}
function copy(file: ControlledFile): ControlledFile {
  return Object.freeze({ ...file, bytes: Buffer.from(file.bytes) });
}

/**
 * Trusted operator seam AFTER qualified installation/death and BEFORE launch.
 * originalPaths/mappedOriginalPaths must already pin the two native paths in
 * the existing native adapter. No arbitrary path or new native API is added.
 */
export async function prepareControlledStartupInputs(ports: {
  readonly native: Pick<
    ControlledNativeAdapter,
    "preflight" | "readOriginal" | "assertOriginal" | "captureSynchronousFence"
  >;
  readonly expected: StartupPolicyExpected;
  /** Original controller/operator phase, not a serialized "before launch" flag. */
  assertBeforeLaunch(): void;
  assertHeld(): void;
  assertHeldCurrent(): Promise<void>;
}): Promise<ControlledStartupInputs> {
  const native = ports.native;
  const expected = structuredClone(ports.expected);
  const { assertBeforeLaunch, assertHeld, assertHeldCurrent } = ports;
  let revoked = false;
  let mapped: (() => void) | undefined;
  const files: ControlledFile[] = [];
  const check = () => {
    if (revoked) deny();
    try {
      synchronous(assertHeld);
      if (mapped) synchronous(mapped);
      synchronous(assertHeld);
    } catch (error) {
      revoked = true;
      throw error;
    }
  };
  const held = async () => {
    check();
    const result: unknown = await assertHeldCurrent();
    if (result !== undefined) {
      revoked = true;
      deny();
    }
    check();
  };
  try {
    synchronous(assertBeforeLaunch);
    await held();
    await native.preflight();
    await held();
    if (expected.autorunPaths.length !== 2) deny();
    for (const file of expected.autorunPaths) {
      await held();
      const original = copy(await native.readOriginal(file));
      await held();
      if (
        original.nativePath !== file ||
        createHash("sha256").update(original.bytes).digest("hex") !==
          original.sha256
      )
        deny();
      files.push(original);
    }
    assertControlledPythonAutorunData(expected.autorunPaths, files);
    const verify = async () => {
      try {
        await held();
        await native.preflight();
        await held();
        for (const file of files) {
          await native.assertOriginal(file);
          await held();
        }
      } catch (error) {
        revoked = true;
        throw error;
      }
    };
    await verify();
    mapped = native.captureSynchronousFence(files);
    check();
    await verify();
    check();
    synchronous(assertBeforeLaunch);
    const witness = Object.freeze({}) as ControlledStartupInputs;
    originals.set(witness, { expected, files, check, verify });
    return witness;
  } catch (error) {
    revoked = true;
    throw error;
  }
}
export function assertControlledStartupInputs(
  inputs: ControlledStartupInputs,
): void {
  const original = originals.get(inputs);
  if (!original) deny();
  original.check();
}
export async function verifyControlledStartupInputs(
  inputs: ControlledStartupInputs,
): Promise<void> {
  const original = originals.get(inputs);
  if (!original) deny();
  original.check();
  await original.verify();
  original.check();
}
/** Copies only, while the original synchronous source/input/lease fence holds. */
export function readControlledStartupInputs(inputs: ControlledStartupInputs) {
  const original = originals.get(inputs);
  if (!original) deny();
  original.check();
  return {
    expected: structuredClone(original.expected),
    files: original.files.map(copy),
  };
}
