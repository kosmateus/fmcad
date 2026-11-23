/**
 * Current runtime identity, not execution permission. Queue/session grants and
 * durable recovery evidence remain owned by their existing modules.
 */
interface RuntimeInstanceIdentity {
  readonly pid: number;
  readonly birth: string;
  readonly version: string;
}

export interface RuntimeAuthorityPins<
  Instance extends RuntimeInstanceIdentity = RuntimeInstanceIdentity,
> {
  readonly instance: Readonly<Instance> | null;
  readonly identityFile: string;
  readonly epochId: string | null;
  readonly root: string;
  readonly buildHash: string;
  readonly configHash: string;
  readonly processUnavailable: boolean;
}

declare const authorityCapture: unique symbol;
export interface RuntimeAuthorityCapture {
  readonly [authorityCapture]: true;
}

export interface RuntimeAuthorityVerification<
  Instance extends RuntimeInstanceIdentity = RuntimeInstanceIdentity,
> {
  /** Synchronous read/check of original durable identity and owner pins. */
  verifyCurrent(pins: RuntimeAuthorityPins<Instance>): boolean;
  /**
   * Verify the already-established durable transition, including its original
   * owner/epoch lineage. A caller-supplied next identity alone is not evidence.
   * This does not write records or probe/replay physical work.
   */
  verifyTransition(
    previous: RuntimeAuthorityPins<Instance>,
    next: RuntimeAuthorityPins<Instance>,
  ): boolean;
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutable<Instance extends RuntimeInstanceIdentity>(
  pins: RuntimeAuthorityPins<Instance>,
): RuntimeAuthorityPins<Instance> {
  return Object.freeze({
    instance: pins.instance ? freeze(structuredClone(pins.instance)) : null,
    identityFile: pins.identityFile,
    epochId: pins.epochId,
    root: pins.root,
    buildHash: pins.buildHash,
    configHash: pins.configHash,
    processUnavailable: pins.processUnavailable,
  });
}

function stale(): never {
  throw Object.assign(new Error("Runtime authority changed or is unverified"), {
    code: "RUNTIME_AUTHORITY_CHANGED",
  });
}

export function createQueueRuntimeAuthority<
  Instance extends RuntimeInstanceIdentity,
>(
  initial: RuntimeAuthorityPins<Instance>,
  { verifyCurrent, verifyTransition }: RuntimeAuthorityVerification<Instance>,
) {
  let current = immutable(initial);
  const captures = new WeakMap<
    RuntimeAuthorityCapture,
    RuntimeAuthorityPins<Instance>
  >();
  const original = (capture: RuntimeAuthorityCapture) => {
    const pins = captures.get(capture);
    if (!pins || pins !== current) stale();
    return pins;
  };
  return Object.freeze({
    /** Diagnostic only: even a genuine snapshot cannot stand in for a capture. */
    snapshot: (): RuntimeAuthorityPins<Instance> => current,
    capture(): RuntimeAuthorityCapture {
      const pins = current;
      if (verifyCurrent(pins) !== true || pins !== current) stale();
      const capture = Object.freeze({}) as RuntimeAuthorityCapture;
      captures.set(capture, current);
      return capture;
    },
    /** Recheck the original capture after await, immediately before the effect. */
    assertCurrent(capture: RuntimeAuthorityCapture): void {
      const pins = original(capture);
      if (verifyCurrent(pins) !== true) stale();
      // Verifiers are synchronous, but must not be able to reenter a transition.
      original(capture);
    },
    transition(
      capture: RuntimeAuthorityCapture,
      next: RuntimeAuthorityPins<Instance>,
    ): RuntimeAuthorityPins<Instance> {
      const previous = original(capture);
      const candidate = immutable(next);
      if (verifyTransition(previous, candidate) !== true) stale();
      original(capture);
      current = candidate;
      return current;
    },
  });
}
