import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

export interface ControlledIngressIdentity {
  readonly owner: {
    readonly pid: number;
    readonly birth: string;
    readonly nonce: string;
  };
  readonly pins: {
    readonly buildHash: string;
    readonly configHash: string;
    readonly generation: string;
  };
  readonly native: {
    readonly pid: number;
    readonly birth: string;
    readonly source: string;
    readonly build: string;
    readonly instance: string;
    readonly epoch: string;
  };
}
declare const ingressBrand: unique symbol;
/** Original private broker object only; never a serialized dispatch grant. */
export interface ControlledIngressWindow {
  readonly [ingressBrand]: true;
}
const originals = new WeakMap<
  object,
  {
    readonly identity: ControlledIngressIdentity;
    fence(requireActive: boolean): void;
  }
>();
function deny(): never {
  throw new Error("Original current controlled broker ingress required");
}
function synchronous(check: () => void) {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    deny();
  }
}
function fields(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).sort().join() === keys.sort().join()
  );
}
function identity(value: ControlledIngressIdentity): ControlledIngressIdentity {
  if (
    !fields(value, ["owner", "pins", "native"]) ||
    !fields(value.owner, ["pid", "birth", "nonce"]) ||
    !fields(value.pins, ["buildHash", "configHash", "generation"]) ||
    !fields(value.native, [
      "pid",
      "birth",
      "source",
      "build",
      "instance",
      "epoch",
    ])
  )
    deny();
  for (const process of [value.owner, value.native])
    if (
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 0 ||
      typeof process.birth !== "string" ||
      !process.birth ||
      process.birth.length > 256
    )
      deny();
  for (const hash of [
    value.pins.buildHash,
    value.pins.configHash,
    value.pins.generation,
    value.native.build,
  ])
    if (!/^[a-f0-9]{64}$/.test(hash)) deny();
  if (!/^[a-f0-9]{40}$/.test(value.native.source)) deny();
  for (const name of [
    value.owner.nonce,
    value.native.instance,
    value.native.epoch,
  ])
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 256 ||
      name.includes("\0")
    )
      deny();
  return structuredClone(value);
}

export function assertControlledIngressWindow(
  window: ControlledIngressWindow,
  expected: ControlledIngressIdentity,
): void {
  const original = originals.get(window);
  if (!original || !isDeepStrictEqual(original.identity, expected)) deny();
  original.fence(true);
}

/** Continuity while the new broker is still paused; not dispatch eligibility. */
export function assertControlledIngressTransition(
  window: ControlledIngressWindow,
  expected: ControlledIngressIdentity,
): void {
  const original = originals.get(window);
  if (!original || !isDeepStrictEqual(original.identity, expected)) deny();
  original.fence(false);
}

/** Data readback requires the original live object; the returned copy is no grant. */
export function readControlledIngressIdentity(
  window: ControlledIngressWindow,
): ControlledIngressIdentity {
  const original = originals.get(window);
  if (!original) deny();
  original.fence(false);
  return structuredClone(original.identity);
}

/**
 * Private same-process broker seam. readCurrent must check the real live owner,
 * full executable bytes, native generation and consumed root, not read a caller
 * declaration. This witness adds continuity; it does not replace native proof.
 *
 * observe must wrap EVERY physical outgoing path, including lifecycle probes.
 * Only real compiler/certificate/domain-verified stdout enters withStdoutWire.
 * Existing closed services and fixed readiness observations use their own
 * original private guards via withClosedServiceWire, never metadataOnly flags.
 * An unqualified physical send irreversibly revokes the window before transport,
 * without granting or suppressing that operation's ordinary authority.
 */
export function createControlledIngressWindow(
  readCurrent: () => ControlledIngressIdentity,
  phases: {
    /** Actual paused idle gate, original native grant and no pending producers. */
    assertTransferClosed(): void;
    /** Actual completed supported resume, RUNNING gate and no active operation. */
    assertActivatedIdle(): void;
  },
) {
  let expected: ControlledIngressIdentity | undefined;
  const scope = new AsyncLocalStorage<{
    wire: object;
    assertOriginal(): void;
    requireActive: boolean;
  }>();
  let sealed = false;
  let opened = false;
  let revoked = false;
  let originalWindow: ControlledIngressWindow | undefined;
  function fence(requireActive: boolean) {
    // Pending is valid continuity, but not dispatch eligibility. A read of
    // eligibility must not destroy the operator's still-closed handoff.
    if (requireActive && !opened) deny();
    try {
      if (
        !sealed ||
        (requireActive && !opened) ||
        revoked ||
        !expected ||
        !isDeepStrictEqual(identity(readCurrent()), expected)
      )
        deny();
    } catch (error) {
      revoked = true;
      throw error;
    }
  }
  function sealForTransfer(): ControlledIngressWindow {
    if (sealed || revoked) deny();
    try {
      synchronous(() => phases.assertTransferClosed());
      expected = identity(readCurrent());
      sealed = true;
      fence(false);
      const window = Object.freeze({}) as ControlledIngressWindow;
      originals.set(window, { identity: expected, fence });
      originalWindow = window;
      return window;
    } catch (error) {
      revoked = true;
      throw error;
    }
  }
  function observeContinuity(requireActive: boolean) {
    if (requireActive) {
      fence(true);
    } else if (!revoked) {
      try {
        fence(false);
      } catch {
        // Revocation is permanent, but this optional witness is not the
        // independently guarded closed service's authority.
      }
    }
  }
  async function withVerifiedWire<T>(
    requireActive: boolean,
    wire: object,
    assertOriginal: () => void,
    send: () => Promise<T>,
  ): Promise<T> {
    if (requireActive && !opened) deny();
    try {
      fence(requireActive);
      synchronous(assertOriginal);
      fence(requireActive);
      const result = await scope.run(
        { wire, assertOriginal, requireActive },
        send,
      );
      fence(requireActive);
      return result;
    } catch (error) {
      revoked = true;
      throw error;
    }
  }
  return Object.freeze({
    sealForTransfer,
    open(): ControlledIngressWindow {
      if (opened || revoked) deny();
      if (!sealed) sealForTransfer();
      try {
        synchronous(() => phases.assertActivatedIdle());
        fence(false);
        opened = true;
        fence(true);
        return originalWindow!;
      } catch (error) {
        revoked = true;
        throw error;
      }
    },
    /** Called immediately before the actual underlying transport. */
    observe(wire: object): void {
      const original = scope.getStore();
      if (!original) {
        revoked = true;
        return;
      }
      try {
        observeContinuity(original.requireActive);
        if (wire !== original.wire) deny();
        synchronous(original.assertOriginal);
        observeContinuity(original.requireActive);
      } catch (error) {
        revoked = true;
        throw error;
      }
    },
    async withStdoutWire<T>(
      wire: object,
      assertOriginal: () => void,
      send: () => Promise<T>,
    ): Promise<T> {
      return withVerifiedWire(true, wire, assertOriginal, send);
    },
    /** Only existing closed compiler/domain/certificate-bound services and
     * broker-generated fixed readiness observations; never merely typed code. */
    async withClosedServiceWire<T>(
      wire: object,
      assertOriginal: () => void,
      send: () => Promise<T>,
    ): Promise<T> {
      // Losing the optional diagnostic profile must not fail a different
      // operation whose own closed compiler/domain/certificate remains valid.
      // Unlike stdout, this is not a claim that the window still holds.
      synchronous(assertOriginal);
      observeContinuity(false);
      return scope.run({ wire, assertOriginal, requireActive: false }, send);
    },
    revoke(): void {
      revoked = true;
    },
  });
}
