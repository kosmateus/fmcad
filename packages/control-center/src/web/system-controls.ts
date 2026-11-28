/// <reference lib="dom" />

import { API_ROOT, API_VERSION, CSRF_HEADER } from "./api.js";
import type { FetchLike } from "./api.js";
import type { ConsoleQueryScope } from "../contracts/query.js";
import type {
  SystemControlAction,
  SystemControlCommand,
  SystemControlReceipt,
  SystemControlStatus,
} from "../contracts/system-controls.js";
import { SYSTEM_CONTROLS_API_VERSION } from "../contracts/system-controls.js";

export type SystemControlTranslate = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

export type SystemControlFormatNumber = (
  value: number,
  options?: Intl.NumberFormatOptions,
) => string;

export interface SystemControlPendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PENDING_STORAGE_KEY = "fmcad.control-center.system-controls.pending.v1";

export class SystemControlsClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SystemControlsClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameScope(left: ConsoleQueryScope, right: ConsoleQueryScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      (right.kind === "project" && left.projectId === right.projectId))
  );
}

function isScope(value: unknown): value is ConsoleQueryScope {
  if (!isRecord(value)) return false;
  return value["kind"] === "global"
    ? Object.keys(value).every((key) => key === "kind")
    : value["kind"] === "project" &&
        typeof value["projectId"] === "string" &&
        value["projectId"].trim().length > 0 &&
        Object.keys(value).every((key) => ["kind", "projectId"].includes(key));
}

function isGlobalScope(value: unknown): value is { readonly kind: "global" } {
  return (
    isRecord(value) &&
    value["kind"] === "global" &&
    Object.keys(value).every((key) => key === "kind")
  );
}

function addScope(url: URL, scope: ConsoleQueryScope): void {
  url.searchParams.set("scope", scope.kind);
  if (scope.kind === "project")
    url.searchParams.set("projectId", scope.projectId);
}

function validSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const capabilities = value["capabilities"];
  return (
    value["protocol"] === 1 &&
    typeof value["instanceId"] === "string" &&
    typeof value["buildHash"] === "string" &&
    Number.isSafeInteger(value["generation"]) &&
    Number(value["generation"]) >= 0 &&
    typeof value["phase"] === "string" &&
    Number.isSafeInteger(value["activeOperations"]) &&
    Number(value["activeOperations"]) >= 0 &&
    typeof value["unresolved"] === "boolean" &&
    typeof value["gateClosed"] === "boolean" &&
    isRecord(capabilities) &&
    Object.values(capabilities).every((entry) => typeof entry === "boolean")
  );
}

function validStatus(
  value: unknown,
  expectedScope: ConsoleQueryScope,
): value is SystemControlStatus {
  if (!isRecord(value) || value["version"] !== SYSTEM_CONTROLS_API_VERSION)
    return false;
  const caps = value["capabilities"];
  const scope = value["requestedScope"];
  const effectiveScope = value["effectiveScope"];
  return (
    (value["state"] === "available" || value["state"] === "unavailable") &&
    isScope(scope) &&
    sameScope(scope, expectedScope) &&
    isGlobalScope(effectiveScope) &&
    isRecord(caps) &&
    ["pause", "drain", "resume", "start"].every(
      (key) => typeof caps[key] === "boolean",
    ) &&
    (value["observedAt"] === null ||
      (typeof value["observedAt"] === "number" &&
        Number.isFinite(value["observedAt"]))) &&
    (value["snapshot"] === null || validSnapshot(value["snapshot"])) &&
    (value["state"] !== "available" || validSnapshot(value["snapshot"]))
  );
}

function validReceipt(
  value: unknown,
  expected: Pick<
    SystemControlCommand,
    "scope" | "action" | "requestId" | "instanceId" | "expectedGeneration"
  >,
): value is SystemControlReceipt {
  if (!isRecord(value) || value["version"] !== SYSTEM_CONTROLS_API_VERSION)
    return false;
  const scope = value["requestedScope"];
  const effectiveScope = value["effectiveScope"];
  return (
    isScope(scope) &&
    sameScope(scope, expected.scope) &&
    isGlobalScope(effectiveScope) &&
    value["action"] === expected.action &&
    value["requestId"] === expected.requestId &&
    value["instanceId"] === expected.instanceId &&
    value["expectedGeneration"] === expected.expectedGeneration &&
    ["confirmed", "accepted", "pending", "unknown", "conflict"].includes(
      String(value["state"]),
    ) &&
    (value["snapshot"] === null || validSnapshot(value["snapshot"]))
  );
}

function uncertainReceipt(
  command: SystemControlCommand,
  reason: string,
): SystemControlReceipt {
  return {
    version: SYSTEM_CONTROLS_API_VERSION,
    requestedScope: command.scope,
    effectiveScope: { kind: "global" },
    requestId: command.requestId,
    action: command.action,
    instanceId: command.instanceId,
    expectedGeneration: command.expectedGeneration,
    state: "unknown",
    snapshot: null,
    reason,
  };
}

export class SystemControlsClient {
  readonly #root: URL;
  #csrfToken: string | null = null;
  #sessionRequest: Promise<string> | null = null;
  readonly #pendingStorage: SystemControlPendingStorage | null;
  readonly #settled = new Map<
    string,
    {
      readonly command: SystemControlCommand;
      readonly receipt: SystemControlReceipt;
    }
  >();

  constructor(
    origin: string,
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    storage?: SystemControlPendingStorage | null,
  ) {
    this.#root = new URL(API_ROOT, origin);
    if (this.#root.origin !== new URL(origin).origin)
      throw new TypeError("System controls must use the current origin");
    if (storage !== undefined) this.#pendingStorage = storage;
    else {
      try {
        this.#pendingStorage = globalThis.localStorage;
      } catch {
        this.#pendingStorage = null;
      }
    }
  }

  async status(
    scope: ConsoleQueryScope,
    signal?: AbortSignal,
  ): Promise<SystemControlStatus> {
    await this.ensureSession();
    const url = this.url("system-controls");
    addScope(url, scope);
    const value = await this.requestJson(url, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!validStatus(value, scope)) this.invalidResponse();
    return value;
  }

  async receipt(
    command: SystemControlCommand,
    signal?: AbortSignal,
  ): Promise<SystemControlReceipt> {
    await this.ensureSession();
    const url = this.url(
      `system-controls/receipts/${encodeURIComponent(command.requestId)}`,
    );
    addScope(url, command.scope);
    url.searchParams.set("action", command.action);
    url.searchParams.set("instanceId", command.instanceId);
    url.searchParams.set(
      "expectedGeneration",
      String(command.expectedGeneration),
    );
    const value = await this.requestJson(url, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!validReceipt(value, command)) this.invalidResponse();
    return value;
  }

  async execute(
    command: SystemControlCommand,
    signal?: AbortSignal,
  ): Promise<SystemControlReceipt> {
    const settled = this.#settled.get(command.requestId);
    if (settled) {
      if (!sameCommand(settled.command, command))
        throw new SystemControlsClientError(
          "The request ID already belongs to a different action.",
          "REQUEST_CONFLICT",
          409,
        );
      return settled.receipt;
    }
    const previous = this.readPending();
    if (previous) {
      if (!sameCommand(previous, command))
        throw new SystemControlsClientError(
          "Another control request is pending or unknown; reconcile its original receipt first.",
          "CONTROL_RECEIPT_PENDING",
          409,
        );
      return this.reconcile(command);
    }
    this.writePending(command);

    let response: unknown;
    try {
      const csrfToken = await this.ensureSession();
      response = await this.requestJson(this.url("system-controls"), {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify(command),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (
        error instanceof SystemControlsClientError &&
        [400, 401, 403, 404, 415].includes(error.status)
      ) {
        this.clearPending(command);
        throw error;
      }
      return this.reconcile(command);
    }
    if (validReceipt(response, command)) {
      this.finishIfTerminal(command, response);
      return response;
    }
    return this.reconcile(command);
  }

  async reconcilePending(): Promise<SystemControlReceipt | null> {
    const command = this.readPending();
    return command ? this.reconcile(command) : null;
  }

  canMutate(): boolean {
    if (!this.#pendingStorage) return false;
    try {
      return this.readPending() === null;
    } catch {
      return false;
    }
  }

  hasPending(): boolean {
    return this.readPending() !== null;
  }

  private async reconcile(
    command: SystemControlCommand,
  ): Promise<SystemControlReceipt> {
    try {
      const receipt = await this.receipt(command);
      this.finishIfTerminal(command, receipt);
      return receipt;
    } catch {
      return uncertainReceipt(
        command,
        "The outcome is unknown. Read the original receipt; this action will not be sent again.",
      );
    }
  }

  private readPending(): SystemControlCommand | null {
    const storage = this.#pendingStorage;
    if (!storage)
      throw new SystemControlsClientError(
        "Persistent storage is unavailable; controls are disabled to prevent replay after a lost acknowledgement.",
        "PENDING_STORAGE_UNAVAILABLE",
        0,
      );
    let text: string | null;
    try {
      text = storage.getItem(PENDING_STORAGE_KEY);
    } catch {
      throw new SystemControlsClientError(
        "Persistent storage is unavailable; controls are disabled to prevent replay after a lost acknowledgement.",
        "PENDING_STORAGE_UNAVAILABLE",
        0,
      );
    }
    if (!text) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (
        isRecord(value) &&
        value["version"] === SYSTEM_CONTROLS_API_VERSION &&
        isRecord(value["scope"]) &&
        (value["scope"]["kind"] === "global" ||
          (value["scope"]["kind"] === "project" &&
            typeof value["scope"]["projectId"] === "string")) &&
        ["pause", "drain", "resume", "start"].includes(
          String(value["action"]),
        ) &&
        typeof value["requestId"] === "string" &&
        typeof value["instanceId"] === "string" &&
        Number.isSafeInteger(value["expectedGeneration"])
      )
        return value as unknown as SystemControlCommand;
    } catch {
      // A corrupted control receipt pointer must keep mutation disabled.
    }
    throw new SystemControlsClientError(
      "A stored control request cannot be verified; do not issue a new action.",
      "CONTROL_RECEIPT_UNKNOWN",
      0,
    );
  }

  private writePending(command: SystemControlCommand): void {
    try {
      this.#pendingStorage?.setItem(
        PENDING_STORAGE_KEY,
        JSON.stringify(command),
      );
    } catch {
      throw new SystemControlsClientError(
        "Persistent storage is unavailable; no control action was sent.",
        "PENDING_STORAGE_UNAVAILABLE",
        0,
      );
    }
    if (!this.#pendingStorage)
      throw new SystemControlsClientError(
        "Persistent storage is unavailable; no control action was sent.",
        "PENDING_STORAGE_UNAVAILABLE",
        0,
      );
  }

  private clearPending(command: SystemControlCommand): void {
    const current = this.readPending();
    if (current && sameCommand(current, command))
      this.#pendingStorage?.removeItem(PENDING_STORAGE_KEY);
  }

  private finishIfTerminal(
    command: SystemControlCommand,
    receipt: SystemControlReceipt,
  ): void {
    if (receipt.state === "confirmed" || receipt.state === "conflict") {
      this.#settled.set(command.requestId, { command, receipt });
      this.clearPending(command);
    }
  }

  private url(resource: string): URL {
    return new URL(resource, `${this.#root.href}/`);
  }

  private async ensureSession(): Promise<string> {
    if (this.#csrfToken) return this.#csrfToken;
    if (this.#sessionRequest) return this.#sessionRequest;
    const pending = this.requestJson(this.url("session"), {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    })
      .then((value) => {
        if (
          !isRecord(value) ||
          value["version"] !== API_VERSION ||
          typeof value["csrfToken"] !== "string" ||
          !/^[a-f0-9]{64}$/.test(value["csrfToken"])
        )
          this.invalidResponse();
        this.#csrfToken = value["csrfToken"];
        return value["csrfToken"];
      })
      .finally(() => {
        if (this.#sessionRequest === pending) this.#sessionRequest = null;
      });
    this.#sessionRequest = pending;
    return pending;
  }

  private async requestJson(url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new SystemControlsClientError(
        "The local Control Center could not be reached.",
        "NETWORK_ERROR",
        0,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new SystemControlsClientError(
        "The local Control Center returned an invalid response.",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    if (!response.ok) {
      const error = isRecord(value) ? value : {};
      throw new SystemControlsClientError(
        typeof error["message"] === "string"
          ? error["message"]
          : "System controls request failed.",
        typeof error["code"] === "string"
          ? error["code"]
          : `HTTP_${response.status}`,
        response.status,
      );
    }
    return value;
  }

  private invalidResponse(): never {
    throw new SystemControlsClientError(
      "The local Control Center returned an incompatible system control response.",
      "INVALID_RESPONSE",
      200,
    );
  }
}

function sameCommand(
  left: SystemControlCommand,
  right: SystemControlCommand,
): boolean {
  return (
    left.action === right.action &&
    left.instanceId === right.instanceId &&
    left.expectedGeneration === right.expectedGeneration &&
    sameScope(left.scope, right.scope)
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

const ACTIONS: readonly SystemControlAction[] = [
  "pause",
  "drain",
  "resume",
  "start",
];

function phaseKey(status: SystemControlStatus): string {
  if (status.state !== "available" || !status.snapshot)
    return "system.controls.phase.offline";
  if (
    status.snapshot.unresolved ||
    status.snapshot.phase === "RECOVERY_BLOCKED"
  )
    return "system.controls.phase.recoveryBlocked";
  if (
    ["PAUSING", "DRAINING"].includes(status.snapshot.phase) &&
    status.snapshot.activeOperations > 0
  )
    return "system.controls.phase.draining";
  switch (status.snapshot.phase) {
    case "RUNNING":
      return "system.controls.phase.running";
    case "PAUSED":
      return "system.controls.phase.paused";
    case "PAUSING":
    case "DRAINING":
      return "system.controls.phase.pausing";
    case "STOPPED":
      return "system.controls.phase.stopped";
    default:
      return "system.controls.phase.unknown";
  }
}

function actionEnabled(
  status: SystemControlStatus,
  action: SystemControlAction,
  hasUnresolvedRequest: boolean,
  clientCanMutate: boolean,
): boolean {
  const snapshot = status.snapshot;
  if (
    status.state !== "available" ||
    !snapshot ||
    snapshot.unresolved ||
    hasUnresolvedRequest ||
    !clientCanMutate
  )
    return false;
  if (status.capabilities[action] !== true) return false;
  if (action === "pause" || action === "drain")
    return snapshot.phase === "RUNNING";
  if (action === "resume")
    return snapshot.phase === "PAUSED" && snapshot.gateClosed;
  return snapshot.phase === "STOPPED";
}

export function createSystemControlCommand(
  status: SystemControlStatus,
  scope: ConsoleQueryScope,
  action: SystemControlAction,
  requestId = newSystemControlRequestId(),
): SystemControlCommand {
  if (
    status.state !== "available" ||
    !status.snapshot ||
    !sameScope(status.requestedScope, scope) ||
    !actionEnabled(status, action, false, true)
  )
    throw new SystemControlsClientError(
      "The fresh broker state does not allow this action.",
      "STATE_CONFLICT",
      409,
    );
  return {
    version: SYSTEM_CONTROLS_API_VERSION,
    scope,
    action,
    requestId,
    instanceId: status.snapshot.instanceId,
    expectedGeneration: status.snapshot.generation,
  };
}

/** Existing app.ts can mount this renderer without surrendering its layout. */
export function renderSystemControls(
  status: SystemControlStatus,
  scope: ConsoleQueryScope,
  translate: SystemControlTranslate,
  projectName?: string,
  formatNumber: SystemControlFormatNumber = (value) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
      value,
    ),
  pendingReceipt: SystemControlReceipt | null = null,
  clientCanMutate = true,
): string {
  const phase = phaseKey(status);
  const snapshot = status.snapshot;
  const phaseParams =
    phase === "system.controls.phase.draining" && snapshot
      ? { activeOperations: formatNumber(snapshot.activeOperations) }
      : undefined;
  const globalNotice = translate("system.controls.accessible.globalScope");
  const scopeNotice =
    scope.kind === "project"
      ? translate("system.controls.scope.project", {
          projectName: projectName ?? scope.projectId,
        })
      : globalNotice;
  const buttons = ACTIONS.map((action) => {
    const label = translate(`system.controls.action.${action}`);
    const allowed = actionEnabled(
      status,
      action,
      !!pendingReceipt,
      clientCanMutate,
    );
    const reason = pendingReceipt
      ? translate("system.controls.safety.noReplay")
      : !clientCanMutate
        ? translate("system.controls.error.storageUnavailable")
        : status.state !== "available"
          ? translate("system.controls.error.offline")
          : snapshotUnavailableReason(status, translate);
    const accessible = allowed
      ? translate("system.controls.accessible.action", { action: label })
      : translate("system.controls.accessible.disabled", {
          action: label,
          reason: translate("system.controls.error.capabilityUnavailable", {
            reason,
          }),
        });
    return `<button class="btn small" type="button" data-system-control-action="${action}" aria-label="${escapeHtml(accessible)}" ${allowed ? "" : "disabled"}>${escapeHtml(label)}</button>`;
  }).join("");
  const phaseText = translate(phase, phaseParams);
  const statusText =
    status.state === "unavailable"
      ? translate("system.controls.phase.offline")
      : phaseText;
  const receiptMarkup = pendingReceipt
    ? renderSystemControlReceipt(pendingReceipt, translate)
    : "";
  return `<section class="panel system-panel" data-system-controls data-control-scope="global"><div class="panel-head"><div><h2>${escapeHtml(translate("system.controls.title"))}</h2><p class="panel-subtitle">${escapeHtml(scopeNotice)}</p></div><button class="btn small" type="button" data-system-control-refresh aria-label="${escapeHtml(translate("system.controls.action.refresh"))}">${escapeHtml(translate("system.controls.action.refresh"))}</button></div><p class="system-note">${escapeHtml(globalNotice)}</p><p class="system-note">${escapeHtml(translate("system.controls.scope.managedOnly"))}</p><p role="status" aria-live="polite" aria-label="${escapeHtml(translate("system.controls.accessible.status"))}"><strong>${escapeHtml(translate("system.controls.status.label"))}:</strong> ${escapeHtml(statusText)}</p>${receiptMarkup}<div class="control-actions">${buttons}</div><p class="system-note">${escapeHtml(translate("system.controls.safety.noReplay"))}</p></section>`;
}

export function renderSystemControlConfirmation(
  action: SystemControlAction,
  projectName: string | null,
  translate: SystemControlTranslate,
): string {
  const label = translate(`system.controls.action.${action}`);
  const scope = projectName
    ? translate("system.controls.scope.project", { projectName })
    : translate("system.controls.accessible.globalScope");
  return `<div class="modal-overlay" data-system-control-confirm role="dialog" aria-modal="true" aria-labelledby="system-control-confirm-title"><section class="modal"><div class="modal-header"><h2 id="system-control-confirm-title">${escapeHtml(translate("system.controls.title"))}</h2></div><div class="modal-body"><p>${escapeHtml(scope)}</p><p>${escapeHtml(translate("system.controls.scope.managedOnly"))}</p><p>${escapeHtml(translate("system.controls.safety.noReplay"))}</p></div><div class="modal-footer"><button class="btn" type="button" data-system-control-cancel>${escapeHtml(translate("system.controls.confirm.cancel"))}</button><button class="btn primary" type="button" data-system-control-confirm-action="${action}" aria-label="${escapeHtml(translate("system.controls.accessible.action", { action: label }))}">${escapeHtml(label)}</button></div></section></div>`;
}

function snapshotUnavailableReason(
  status: SystemControlStatus,
  translate: SystemControlTranslate,
): string {
  if (
    [
      "CONTROL_RECEIPT_PENDING",
      "CONTROL_RECEIPT_UNAVAILABLE",
      "PENDING_RECEIPT_READER_UNAVAILABLE",
      "DURABLE_RECEIPT_READER_UNAVAILABLE",
    ].includes(status.reason ?? "")
  )
    return translate("system.controls.action.receiptPending");
  if (!status.snapshot) return translate("system.controls.phase.unknown");
  if (status.snapshot.unresolved)
    return translate("system.controls.error.reconciliationRequired");
  return translate("system.controls.phase.unknown");
}

export function renderSystemControlReceipt(
  receipt: SystemControlReceipt,
  translate: SystemControlTranslate,
): string {
  let message: string;
  if (receipt.state === "confirmed") {
    const phaseStatus: SystemControlStatus = {
      version: SYSTEM_CONTROLS_API_VERSION,
      requestedScope: receipt.requestedScope,
      effectiveScope: { kind: "global" },
      state: receipt.snapshot ? "available" : "unavailable",
      observedAt: null,
      snapshot: receipt.snapshot,
      capabilities: NO_BROWSER_CAPABILITIES,
    };
    message = translate("system.controls.action.confirmed", {
      phase: translate(phaseKey(phaseStatus)),
    });
  } else if (receipt.state === "accepted" || receipt.state === "pending") {
    message = translate("system.controls.action.receiptPending");
  } else if (receipt.state === "conflict") {
    const key =
      receipt.code === "STATE_CONFLICT"
        ? "system.controls.error.generationConflict"
        : receipt.code === "INSTANCE_CHANGED"
          ? "system.controls.error.instanceChanged"
          : receipt.code === "RECONCILIATION_REQUIRED"
            ? "system.controls.error.reconciliationRequired"
            : "system.controls.error.capabilityUnavailable";
    message = translate(key, {
      reason: translate("system.controls.phase.unknown"),
      action: translate(`system.controls.action.${receipt.action}`),
    });
  } else {
    message = translate("system.controls.action.unknown");
  }
  const label =
    receipt.state === "pending" || receipt.state === "accepted"
      ? translate("system.controls.accessible.pending")
      : translate("system.controls.accessible.status");
  return `<p class="system-note" role="status" aria-live="polite" aria-label="${escapeHtml(label)}" data-system-control-receipt="${receipt.state}">${escapeHtml(message)}</p>`;
}

const NO_BROWSER_CAPABILITIES = {
  pause: false,
  drain: false,
  resume: false,
  start: false,
};

export function newSystemControlRequestId(): string {
  if (!globalThis.crypto?.randomUUID)
    throw new Error("A secure request ID source is unavailable");
  return globalThis.crypto.randomUUID();
}
