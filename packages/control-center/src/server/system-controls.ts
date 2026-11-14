import { createBrokerControl, isBrokerControlSnapshot } from "@fmcad/core";
import type {
  BrokerAction,
  BrokerControlFence,
  BrokerControlPort,
  BrokerControlSnapshot,
} from "@fmcad/core";
import type {
  ConsoleQueryPrincipal,
  ConsoleQueryScope,
} from "../contracts/query.js";
import type {
  SystemControlAction,
  SystemControlCapabilities,
  SystemControlReceipt,
  SystemControlStatus,
} from "../contracts/system-controls.js";
import { SYSTEM_CONTROLS_API_VERSION } from "../contracts/system-controls.js";

const NO_CAPABILITIES: SystemControlCapabilities = {
  pause: false,
  drain: false,
  resume: false,
  start: false,
};

export interface SystemControlReceiptBinding extends BrokerControlFence {
  readonly action: SystemControlAction;
}

/** Existing broker-owned durable receipt; this module never writes receipts. */
export interface SystemControlReceiptRecord {
  readonly binding: SystemControlReceiptBinding;
  readonly status: "prepared" | "completed" | "unresolved" | "failed";
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export interface SystemControlReceiptReadRequest {
  readonly requestId: string;
  readonly principal: ConsoleQueryPrincipal;
}

export interface SystemControlApplicationOptions {
  /** A null port means controls are not connected to the real lifecycle. */
  readonly control: BrokerControlPort | null;
  /** Reads the original lifecycle/start receipt without dispatching an action. */
  readonly readReceipt?: (
    request: SystemControlReceiptReadRequest,
  ) => Promise<SystemControlReceiptRecord | null>;
  /** Detects any nonterminal global lifecycle receipt, not only one client ID. */
  readonly hasUnresolvedControl?: () => boolean | Promise<boolean>;
  /** Must enforce the caller's trusted read/control scope independently. */
  readonly authorize: (
    principal: ConsoleQueryPrincipal,
    scope: ConsoleQueryScope,
    operation: "read" | "control" | "receipt",
  ) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

export interface SystemControlsRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly body?: unknown;
  /** Established by the existing HTTP session/principal boundary. */
  readonly principal: ConsoleQueryPrincipal;
  /** The existing HTTP boundary supplies its real Origin/session/CSRF check. */
  readonly checkCsrf: () => void;
}

export interface SystemControlsRouteResponse {
  readonly status: number;
  readonly body: unknown;
}

export const SYSTEM_CONTROLS_API_PATH = "/api/v1/console/system-controls";

export class SystemControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SystemControlError";
  }
}

function fail(code: string, message: string): never {
  throw new SystemControlError(code, message);
}

function validScope(value: unknown): value is ConsoleQueryScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope["kind"] === "global"
    ? Object.keys(scope).every((key) => key === "kind")
    : scope["kind"] === "project" &&
        typeof scope["projectId"] === "string" &&
        scope["projectId"].trim().length > 0 &&
        scope["projectId"].length <= 256 &&
        Object.keys(scope).every((key) => ["kind", "projectId"].includes(key));
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validFence(value: unknown): value is BrokerControlFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  return (
    validRequestId(fence["requestId"]) &&
    typeof fence["instanceId"] === "string" &&
    fence["instanceId"].trim().length > 0 &&
    fence["instanceId"].length <= 256 &&
    Number.isSafeInteger(fence["expectedGeneration"]) &&
    Number(fence["expectedGeneration"]) >= 0
  );
}

function validAction(value: unknown): value is SystemControlAction {
  return ["pause", "drain", "resume", "start"].includes(String(value));
}

function capabilities(
  snapshot: BrokerControlSnapshot,
  hasReceiptReader: boolean,
  hasUnresolvedReader: boolean,
  hasUnresolvedControl: boolean,
): SystemControlCapabilities {
  if (
    !hasReceiptReader ||
    !hasUnresolvedReader ||
    hasUnresolvedControl ||
    snapshot.unresolved
  )
    return NO_CAPABILITIES;
  const lifecycle = snapshot.capabilities;
  const transitioning = ["PAUSING", "RESUMING", "DRAINING"].includes(
    snapshot.phase,
  );
  return {
    pause:
      !transitioning &&
      snapshot.phase === "RUNNING" &&
      lifecycle.pause === true,
    drain:
      !transitioning &&
      snapshot.phase === "RUNNING" &&
      lifecycle.drain === true,
    resume:
      !transitioning &&
      snapshot.phase === "PAUSED" &&
      snapshot.gateClosed &&
      lifecycle.resume === true,
    start:
      snapshot.phase === "STOPPED" &&
      snapshot.gateClosed &&
      snapshot.activeOperations === 0 &&
      lifecycle.start === true,
  };
}

function receiptBindingMatches(
  record: SystemControlReceiptRecord,
  expected: SystemControlReceiptBinding,
): boolean {
  const binding = record.binding;
  return (
    binding.action === expected.action &&
    binding.requestId === expected.requestId &&
    binding.instanceId === expected.instanceId &&
    binding.expectedGeneration === expected.expectedGeneration
  );
}

function resultSnapshot(value: unknown): BrokerControlSnapshot | null {
  if (isBrokerControlSnapshot(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>)["control"];
    if (isBrokerControlSnapshot(nested)) return nested;
  }
  return null;
}

function outcomeState(
  action: SystemControlAction,
  expected: SystemControlReceiptBinding,
  record: SystemControlReceiptRecord,
  requestedScope: ConsoleQueryScope,
): SystemControlReceipt {
  if (!receiptBindingMatches(record, expected))
    fail(
      "REQUEST_CONFLICT",
      "The request ID belongs to a different control intent",
    );
  const snapshot = resultSnapshot(record.result);
  const base = {
    version: SYSTEM_CONTROLS_API_VERSION,
    requestedScope,
    effectiveScope: { kind: "global" as const },
    requestId: expected.requestId,
    action,
    instanceId: expected.instanceId,
    expectedGeneration: expected.expectedGeneration,
    snapshot,
  };
  if (record.status !== "completed" || !snapshot)
    return {
      ...base,
      state: record.status === "prepared" ? "pending" : "unknown",
      ...(record.error?.code ? { code: record.error.code } : {}),
      reason:
        "The original broker receipt is not terminal and verified. Do not send the action again.",
    };
  if (
    record.result &&
    typeof record.result === "object" &&
    "requestId" in record.result &&
    record.result.requestId !== expected.requestId
  )
    return {
      ...base,
      state: "unknown",
      reason: "The broker receipt does not match the original request ID.",
    };

  const correctInstance =
    action === "start"
      ? snapshot.instanceId !== expected.instanceId
      : snapshot.instanceId === expected.instanceId;
  const expectedState =
    action === "pause" || action === "drain"
      ? snapshot.gateClosed && ["PAUSED", "PAUSING"].includes(snapshot.phase)
      : action === "resume"
        ? !snapshot.gateClosed && snapshot.phase === "RUNNING"
        : snapshot.gateClosed &&
          snapshot.phase === "PAUSED" &&
          snapshot.activeOperations === 0 &&
          !snapshot.unresolved;
  if (!correctInstance || !expectedState)
    return {
      ...base,
      state: "unknown",
      reason: "The durable broker receipt does not prove the requested state.",
    };
  return {
    ...base,
    state:
      (action === "pause" || action === "drain") &&
      (snapshot.phase === "PAUSING" || snapshot.activeOperations > 0)
        ? "accepted"
        : "confirmed",
  };
}

function unavailableStatus(
  scope: ConsoleQueryScope,
  reason: string,
  observedAt: number | null,
): SystemControlStatus {
  return {
    version: SYSTEM_CONTROLS_API_VERSION,
    requestedScope: scope,
    effectiveScope: { kind: "global" },
    state: "unavailable",
    observedAt,
    snapshot: null,
    capabilities: NO_CAPABILITIES,
    reason,
  };
}

export function createSystemControls(options: SystemControlApplicationOptions) {
  const control = options.control ? createBrokerControl(options.control) : null;
  const hasUnresolvedControl = options.hasUnresolvedControl;
  const now = options.now ?? Date.now;
  const inFlight = new Map<
    string,
    {
      readonly binding: SystemControlReceiptBinding;
      readonly owner: string;
      readonly promise: Promise<SystemControlReceipt>;
    }
  >();

  async function authorize(
    principal: ConsoleQueryPrincipal,
    scope: ConsoleQueryScope,
    operation: "read" | "control" | "receipt",
  ): Promise<void> {
    if (
      !principal.globalRead ||
      !(await options.authorize(principal, scope, operation))
    )
      fail(
        "CONTROL_FORBIDDEN",
        "Access to global broker controls is not authorized",
      );
  }

  async function readReceipt(
    principal: ConsoleQueryPrincipal,
    expected: SystemControlReceiptBinding,
    scope: ConsoleQueryScope,
  ): Promise<SystemControlReceipt | null> {
    if (!options.readReceipt) return null;
    const record = await options.readReceipt({
      requestId: expected.requestId,
      principal,
    });
    if (!record) return null;
    return settleAcceptedReceipt(
      outcomeState(expected.action, expected, record, scope),
    );
  }

  async function settleAcceptedReceipt(
    receipt: SystemControlReceipt,
  ): Promise<SystemControlReceipt> {
    if (receipt.state !== "accepted" || !control || !receipt.snapshot)
      return receipt;
    try {
      const current = await control.read();
      if (
        isBrokerControlSnapshot(current) &&
        current.instanceId === receipt.snapshot.instanceId &&
        current.generation >= receipt.snapshot.generation &&
        current.phase === "PAUSED" &&
        current.gateClosed &&
        current.activeOperations === 0 &&
        !current.unresolved
      )
        return { ...receipt, state: "confirmed", snapshot: current };
    } catch {
      // No new observation does not advance an accepted drain to confirmed.
    }
    return receipt;
  }

  return {
    async status(
      scope: ConsoleQueryScope,
      principal: ConsoleQueryPrincipal,
    ): Promise<SystemControlStatus> {
      if (!validScope(scope))
        fail("INVALID_REQUEST", "System scope is invalid");
      await authorize(principal, scope, "read");
      if (!control)
        return unavailableStatus(scope, "LIFECYCLE_UNAVAILABLE", null);
      try {
        const snapshot = await control.read();
        if (!isBrokerControlSnapshot(snapshot))
          return unavailableStatus(scope, "INVALID_LIFECYCLE_STATE", null);
        let unresolvedReceipt = false;
        if (hasUnresolvedControl) {
          try {
            unresolvedReceipt = await hasUnresolvedControl();
          } catch {
            return {
              version: SYSTEM_CONTROLS_API_VERSION,
              requestedScope: scope,
              effectiveScope: { kind: "global" },
              state: "available",
              observedAt: now(),
              snapshot,
              capabilities: NO_CAPABILITIES,
              reason: "CONTROL_RECEIPT_UNAVAILABLE",
            };
          }
        }
        return {
          version: SYSTEM_CONTROLS_API_VERSION,
          requestedScope: scope,
          effectiveScope: { kind: "global" },
          state: "available",
          observedAt: now(),
          snapshot,
          capabilities: capabilities(
            snapshot,
            !!options.readReceipt,
            !!hasUnresolvedControl,
            unresolvedReceipt,
          ),
          ...(unresolvedReceipt ? { reason: "CONTROL_RECEIPT_PENDING" } : {}),
          ...(!options.readReceipt
            ? { reason: "DURABLE_RECEIPT_READER_UNAVAILABLE" }
            : {}),
          ...(!hasUnresolvedControl
            ? { reason: "PENDING_RECEIPT_READER_UNAVAILABLE" }
            : {}),
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "LIFECYCLE_UNAVAILABLE";
        return unavailableStatus(scope, code, null);
      }
    },

    async receipt(
      scope: ConsoleQueryScope,
      principal: ConsoleQueryPrincipal,
      requestId: string,
      expected?: Pick<
        SystemControlReceiptBinding,
        "action" | "instanceId" | "expectedGeneration"
      >,
    ): Promise<SystemControlReceipt> {
      if (!validScope(scope))
        fail("INVALID_REQUEST", "System scope is invalid");
      if (!validRequestId(requestId))
        fail(
          "INVALID_REQUEST",
          "requestId must contain 1..128 safe characters",
        );
      await authorize(principal, scope, "receipt");
      const cached = inFlight.get(requestId);
      if (cached) {
        if (cached.owner !== principal.subject)
          fail(
            "CONTROL_FORBIDDEN",
            "This receipt belongs to another authenticated client",
          );
        if (
          expected &&
          (cached.binding.action !== expected.action ||
            cached.binding.instanceId !== expected.instanceId ||
            cached.binding.expectedGeneration !== expected.expectedGeneration)
        )
          fail(
            "REQUEST_CONFLICT",
            "The request ID belongs to a different control intent",
          );
        return cached.promise;
      }
      if (
        !expected ||
        !validAction(expected.action) ||
        !validFence({
          requestId,
          instanceId: expected.instanceId,
          expectedGeneration: expected.expectedGeneration,
        })
      )
        fail(
          "INVALID_REQUEST",
          "Receipt lookup requires the original request binding",
        );
      const binding: SystemControlReceiptBinding = { ...expected, requestId };
      const result = await readReceipt(principal, binding, scope);
      return (
        result ?? {
          version: SYSTEM_CONTROLS_API_VERSION,
          requestedScope: scope,
          effectiveScope: { kind: "global" },
          ...binding,
          state: "unknown",
          snapshot: null,
          reason:
            "No authoritative receipt is visible. Do not repeat the action.",
        }
      );
    },

    async execute(
      input: unknown,
      principal: ConsoleQueryPrincipal,
    ): Promise<SystemControlReceipt> {
      if (!control || !options.readReceipt || !hasUnresolvedControl)
        fail(
          "CONTROL_UNAVAILABLE",
          "Lifecycle control and durable receipt lookup are required",
        );
      if (!input || typeof input !== "object" || Array.isArray(input))
        fail("INVALID_REQUEST", "Control request must be an object");
      const request = input as Record<string, unknown>;
      if (
        Object.keys(request).some(
          (key) =>
            ![
              "version",
              "scope",
              "action",
              "requestId",
              "instanceId",
              "expectedGeneration",
            ].includes(key),
        ) ||
        request["version"] !== SYSTEM_CONTROLS_API_VERSION ||
        !validScope(request["scope"]) ||
        !validAction(request["action"]) ||
        !validFence(request)
      )
        fail("INVALID_REQUEST", "Control request is incomplete or invalid");
      const scope = request["scope"];
      const action = request["action"];
      const binding: SystemControlReceiptBinding = {
        action,
        requestId: request["requestId"] as string,
        instanceId: request["instanceId"] as string,
        expectedGeneration: request["expectedGeneration"] as number,
      };
      await authorize(principal, scope, "control");

      const existing = inFlight.get(binding.requestId);
      if (existing) {
        if (existing.owner !== principal.subject)
          fail(
            "CONTROL_FORBIDDEN",
            "This request ID belongs to another authenticated client",
          );
        if (
          existing.binding.action !== binding.action ||
          existing.binding.instanceId !== binding.instanceId ||
          existing.binding.expectedGeneration !== binding.expectedGeneration
        )
          fail(
            "REQUEST_CONFLICT",
            "The request ID belongs to a different control intent",
          );
        return existing.promise;
      }

      const promise = (async (): Promise<SystemControlReceipt> => {
        let before: BrokerControlSnapshot | null = null;
        try {
          const previous = await readReceipt(principal, binding, scope);
          if (previous) return previous;
          if (await hasUnresolvedControl())
            fail(
              "CONTROL_RECEIPT_PENDING",
              "Another global control receipt is pending reconciliation",
            );
          const current = await control.read();
          if (!isBrokerControlSnapshot(current))
            fail("UNSUPPORTED_BROKER", "Broker control status is unavailable");
          before = current;
          if (current.instanceId !== binding.instanceId)
            fail("INSTANCE_CHANGED", "Read the current broker instance");
          if (current.generation !== binding.expectedGeneration)
            fail(
              "STATE_CONFLICT",
              "Read the current broker control generation",
            );
          if (current.unresolved)
            fail(
              "RECONCILIATION_REQUIRED",
              "Unresolved broker work must be reconciled first",
            );
          if (current.capabilities[action] !== true)
            fail(
              "UNSUPPORTED_BROKER",
              "The broker does not implement this action",
            );
          const allowedPhase =
            action === "pause" || action === "drain"
              ? current.phase === "RUNNING"
              : action === "resume"
                ? current.phase === "PAUSED" &&
                  current.gateClosed &&
                  current.activeOperations === 0
                : current.phase === "STOPPED" &&
                  current.gateClosed &&
                  current.activeOperations === 0;
          if (!allowedPhase)
            fail(
              action === "start" ? "BROKER_ALREADY_RUNNING" : "STATE_CONFLICT",
              action === "start"
                ? "Start is only valid for a stopped broker"
                : "Broker is not in a state that allows this action",
            );
          await control.execute(action as BrokerAction, binding);
        } catch (error) {
          const recovered = await readReceipt(principal, binding, scope);
          if (recovered) return recovered;
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "CONTROL_OUTCOME_UNKNOWN";
          const conflict = [
            "STATE_CONFLICT",
            "INSTANCE_CHANGED",
            "UNSUPPORTED_BROKER",
            "RECONCILIATION_REQUIRED",
            "BROKER_ALREADY_RUNNING",
            "CONTROL_RECEIPT_PENDING",
          ].includes(code);
          let snapshot: BrokerControlSnapshot | null = before;
          try {
            const current = await control.read();
            if (isBrokerControlSnapshot(current)) snapshot = current;
          } catch {
            // Keep the missing observation explicit; never infer an idle state.
          }
          return {
            version: SYSTEM_CONTROLS_API_VERSION,
            requestedScope: scope,
            effectiveScope: { kind: "global" },
            ...binding,
            state: conflict ? "conflict" : "unknown",
            snapshot,
            code,
            reason: conflict
              ? "Broker state changed or does not support this action. Refresh before acting."
              : "The action outcome is unknown. Check its original receipt; the action will not be sent again.",
          };
        }
        const receipt = await readReceipt(principal, binding, scope);
        return (
          receipt ?? {
            version: SYSTEM_CONTROLS_API_VERSION,
            requestedScope: scope,
            effectiveScope: { kind: "global" },
            ...binding,
            state: "pending",
            snapshot: null,
            reason:
              "The broker accepted no authoritative receipt yet. Check this request; do not repeat it.",
          }
        );
      })();
      inFlight.set(binding.requestId, {
        binding,
        owner: principal.subject,
        promise,
      });
      const release = () => {
        const current = inFlight.get(binding.requestId);
        if (current?.promise === promise) inFlight.delete(binding.requestId);
      };
      void promise.then(release, release);
      return promise;
    },
  };
}

function scopeFromQuery(query: URLSearchParams): ConsoleQueryScope {
  const kinds = query.getAll("scope");
  const projects = query.getAll("projectId");
  if (kinds.length !== 1 || projects.length > 1)
    fail("INVALID_REQUEST", "System control scope must appear once");
  if (kinds[0] === "global" && projects.length === 0) return { kind: "global" };
  if (kinds[0] === "project" && projects.length === 1) {
    const scope = { kind: "project", projectId: projects[0] } as const;
    if (validScope(scope)) return scope;
  }
  return fail("INVALID_REQUEST", "System control scope is invalid");
}

function routeError(error: unknown): SystemControlsRouteResponse {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "CONTROL_REQUEST_FAILED";
  const message =
    error instanceof Error ? error.message : "System control request failed";
  const status =
    code === "CONTROL_FORBIDDEN"
      ? 403
      : code === "INVALID_REQUEST"
        ? 400
        : [
              "STATE_CONFLICT",
              "INSTANCE_CHANGED",
              "REQUEST_CONFLICT",
              "RECONCILIATION_REQUIRED",
              "BROKER_ALREADY_RUNNING",
            ].includes(code)
          ? 409
          : code.endsWith("UNAVAILABLE")
            ? 503
            : 500;
  return {
    status,
    body: {
      version: SYSTEM_CONTROLS_API_VERSION,
      state:
        status === 403 ? "forbidden" : status === 503 ? "unavailable" : "error",
      code,
      message,
    },
  };
}

/** Route adapter for the existing authenticated HTTP server; no listener or session store is created here. */
export function createSystemControlsRoute(
  application: ReturnType<typeof createSystemControls>,
) {
  return async function handle(
    request: SystemControlsRouteRequest,
  ): Promise<SystemControlsRouteResponse | null> {
    const isBase = request.pathname === SYSTEM_CONTROLS_API_PATH;
    const receiptPrefix = `${SYSTEM_CONTROLS_API_PATH}/receipts/`;
    const isReceipt = request.pathname.startsWith(receiptPrefix);
    if (!isBase && !isReceipt) return null;
    try {
      if (isBase && request.method === "GET") {
        if (
          [...request.query.keys()].some(
            (key) => !["scope", "projectId"].includes(key),
          )
        )
          fail(
            "INVALID_REQUEST",
            "System status query contains unsupported fields",
          );
        const scope = scopeFromQuery(request.query);
        return {
          status: 200,
          body: await application.status(scope, request.principal),
        };
      }
      if (isReceipt && request.method === "GET") {
        if (
          [...request.query.keys()].some(
            (key) =>
              ![
                "scope",
                "projectId",
                "action",
                "instanceId",
                "expectedGeneration",
              ].includes(key),
          )
        )
          fail("INVALID_REQUEST", "Receipt query contains unsupported fields");
        const scope = scopeFromQuery(request.query);
        const requestId = decodeURIComponent(
          request.pathname.slice(receiptPrefix.length),
        );
        const action = querySingle(request.query, "action");
        const instanceId = querySingle(request.query, "instanceId");
        const expectedGeneration = querySingle(
          request.query,
          "expectedGeneration",
        );
        if (
          !validAction(action) ||
          !instanceId ||
          !/^(?:0|[1-9]\d*)$/.test(expectedGeneration ?? "") ||
          !Number.isSafeInteger(Number(expectedGeneration))
        )
          fail(
            "INVALID_REQUEST",
            "Receipt lookup requires the original request binding",
          );
        const body = await application.receipt(
          scope,
          request.principal,
          requestId,
          {
            action,
            instanceId,
            expectedGeneration: Number(expectedGeneration),
          },
        );
        return { status: 200, body };
      }
      if (isBase && request.method === "POST") {
        request.checkCsrf();
        return {
          status: 200,
          body: await application.execute(request.body, request.principal),
        };
      }
      return {
        status: 405,
        body: {
          version: SYSTEM_CONTROLS_API_VERSION,
          state: "error",
          code: "METHOD_NOT_ALLOWED",
          message: "HTTP method is not allowed for this route",
        },
      };
    } catch (error) {
      const boundaryStatus =
        error && typeof error === "object" && "status" in error
          ? Number(error.status)
          : 0;
      if (boundaryStatus === 401 || boundaryStatus === 403)
        return {
          status: boundaryStatus,
          body: {
            version: SYSTEM_CONTROLS_API_VERSION,
            state: "forbidden",
            code: "CSRF_REJECTED",
            message: "Request origin or CSRF token is invalid",
          },
        };
      return routeError(error);
    }
  };
}

function querySingle(query: URLSearchParams, key: string): string | null {
  const values = query.getAll(key);
  if (values.length > 1) fail("INVALID_REQUEST", `${key} must appear once`);
  return values[0] ?? null;
}
