import type { JsonValue } from "../domain/contracts";
import type {
  InvocationContext,
  ObservationEvent,
} from "../domain/observation";
import type { Clock } from "../ports";
import type { EventSink } from "../ports/event-sink";
import type { Presence } from "../ports/presence";

export interface ObservationScopeInput {
  readonly invocation: InvocationContext;
  readonly events: EventSink;
  readonly presence: Presence;
  readonly clock: Clock;
}

export interface ObservationScope {
  readonly publish: (
    name: string,
    data?: Readonly<Record<string, JsonValue>>,
  ) => Promise<boolean>;
  readonly heartbeat: () => Promise<boolean>;
  readonly dispose: () => Promise<void>;
  readonly disposed: boolean;
}

async function bestEffort(effect: () => Promise<void>): Promise<boolean> {
  try {
    await effect();
    return true;
  } catch {
    return false;
  }
}

function timestamp(clock: Clock): number | null {
  try {
    const value = clock.nowMs();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function createObservationScope(
  input: ObservationScopeInput,
): ObservationScope {
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const publish = async (
    name: string,
    data: Readonly<Record<string, JsonValue>> = {},
  ): Promise<boolean> => {
    if (disposed) return false;
    const atMs = timestamp(input.clock);
    if (atMs === null) return false;
    const event: ObservationEvent = {
      version: 1,
      invocation: input.invocation,
      atMs,
      name,
      data,
    };
    return bestEffort(() => input.events.publish(event));
  };

  const heartbeat = async (): Promise<boolean> => {
    if (disposed) return false;
    const atMs = timestamp(input.clock);
    if (atMs === null) return false;
    try {
      await input.presence.heartbeat(input.invocation, atMs);
      return true;
    } catch {
      return false;
    }
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    const atMs = timestamp(input.clock);
    disposePromise = (async () => {
      if (atMs !== null)
        await bestEffort(() => input.presence.dispose(input.invocation, atMs));
      if (input.events.dispose)
        await bestEffort(() => Promise.resolve(input.events.dispose?.()));
    })();
    return disposePromise;
  };

  return {
    publish,
    heartbeat,
    dispose,
    get disposed() {
      return disposed;
    },
  };
}

export interface ObservationPublisher {
  readonly publish: (
    invocation: InvocationContext,
    name: string,
    data?: Readonly<Record<string, JsonValue>>,
  ) => Promise<boolean>;
}

export function createObservationPublisher(
  events: EventSink,
  clock: Clock,
): ObservationPublisher {
  return {
    async publish(invocation, name, data = {}) {
      const atMs = timestamp(clock);
      if (atMs === null) return false;
      const event: ObservationEvent = {
        version: 1,
        invocation,
        atMs,
        name,
        data,
      };
      return bestEffort(() => events.publish(event));
    },
  };
}

export function description(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value) ||
    Array.from(value).length > 1000
  ) {
    throw new Error(
      "--purpose requires at most 1000 Unicode characters without control characters",
    );
  }
  return value.trim() || undefined;
}

export function parseInvocation(argv: readonly string[]): {
  readonly argv: string[];
  readonly description: string | undefined;
} {
  const rest: string[] = [];
  let purpose: string | undefined;
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (argv[i] !== "--purpose") {
      rest.push(argv[i]!);
      continue;
    }
    if (seen) throw new Error("Duplicate --purpose");
    seen = true;
    const value = argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new Error("missing value for --purpose");
    purpose = description(value);
  }
  return { argv: rest, description: purpose };
}
