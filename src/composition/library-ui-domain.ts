import crypto from "node:crypto";
import { pythonLiteral } from "../../packages/node-adapters/src/python/artifact";
export interface UiTarget {
  name: string;
  creationId?: (string | null) | undefined;
  fileId?: (string | null) | undefined;
  commandId?: (string | null) | undefined;
  isSaved?: boolean | undefined;
  isActive?: boolean | undefined;
  isModified?: boolean | undefined;
}
export interface UiLease {
  id: string;
  requestId: string;
  operationId: string;
  expiresAt: number;
  target: UiTarget;
}
export interface UiRequest {
  requestId: string;
  lease: UiLease;
  target: UiTarget;
  intent?: string | undefined;
  expectedCommandId?: string | undefined;
  maxControls?: number | undefined;
  observationId?: string | undefined;
  action?: string | undefined;
  selectionMode?: string | undefined;
  profileId?: string | undefined;
  controlRef?: string | undefined;
  controlName?: string | undefined;
  controlType?: string | undefined;
  containerRef?: string | undefined;
  observedAutomationId?: string | undefined;
  allowedProfiles?: string[] | undefined;
  maxActions?: number | undefined;
  timeBudgetMs?: number | undefined;
}
export interface UiContext {
  doc?: string | undefined;
  docId?: string | undefined;
  docFileId?: string | undefined;
  projectId?: string | undefined;
}
export interface UiIdentity {
  name: string;
  creationId: string | null;
  fileId: string | null;
  commandId: string | null;
  identityPinned: boolean;
}
export interface UiCommand {
  id: string;
  isNative?: (boolean | null) | undefined;
  name?: (string | null) | undefined;
}
export interface UiProbe {
  status?: string | undefined;
  documents?: UiTarget[] | undefined;
  unavailableEvidence?: string[] | undefined;
  processId?: number | undefined;
  activeCommand?: (UiCommand | null) | undefined;
  fusionVersion?: string | undefined;
  identity?: UiTarget | undefined;
  identityPinned?: boolean | undefined;
  backend?: string | undefined;
  sessionFingerprint?: string | undefined;
}
export interface UiProfile {
  intent: string;
  action: string;
  commandId?: string | undefined;
  titleAutomationId?: string | undefined;
  messageAutomationId?: string | undefined;
  buttonAutomationId: string;
  dialogClass?: string | undefined;
  existingTargetOnly?: boolean | undefined;
  preservesUnderlyingFailure?: boolean | undefined;
  localized?:
    | Record<
        string,
        {
          title?: string | undefined;
          message?: string | undefined;
          button: string;
        }
      >
    | undefined;
}
export interface UiQualification {
  profileId: string;
  fusionVersion: string;
  osBuild: string;
  locale: string;
  commandIds?: string[] | undefined;
}
export interface UiControl {
  windowHandle: number;
  containerKey: string;
  runtimeId: string[];
  parentPath: string[];
  automationId: string;
  name: string;
  controlType: string;
  className: string;
  enabled: boolean;
  offscreen: boolean;
  isPassword: boolean;
  invokeAvailable: boolean;
  isModal: boolean;
  semanticRole: string | null;
  fingerprint: string;
  containerRef: string;
  controlRef: string;
}
export interface UiWindow {
  handle: number;
  className: string;
  title: string;
  isMain: boolean;
  isModal: boolean;
  ownerHandle: number;
  containerRef: string;
  containerRefs: string[];
  controls: UiControl[];
}
export interface UiSnapshot {
  status?: string | undefined;
  windows: UiWindow[];
  truncated: boolean;
  controlCount?: number | undefined;
  locale?: string | undefined;
  osBuild?: string | undefined;
  processId?: number | undefined;
  processStartTicks?: string | undefined;
  mainWindowHandle?: number | undefined;
  unavailableEvidence?: string[] | undefined;
}
export interface UiProfileCandidate {
  profileId: string;
  intent: string;
  action: string;
  matchingMethod: string;
  languageIndependent: boolean;
  qualified: boolean;
  qualification?: (UiQualification | null) | undefined;
  actualLocale?: (string | null) | undefined;
  windowHandle: number | null;
  containerRef?: string | undefined;
  controlRef: string | null;
  controlName?: string | undefined;
  controlType?: string | undefined;
  automationId?: string | undefined;
  fingerprint?: string | undefined;
  preservesUnderlyingFailure?: boolean | undefined;
  requiredCommandId?: (string | null) | undefined;
  nativeCommandId?: (string | null) | undefined;
  commandIds?: string[] | undefined;
}
interface RawControl {
  runtimeId?: unknown[] | undefined;
  parentPath?: unknown[] | undefined;
  containerKey?: unknown | undefined;
  automationId?: unknown | undefined;
  name?: unknown | undefined;
  controlType?: unknown | undefined;
  className?: unknown | undefined;
  enabled?: unknown | undefined;
  offscreen?: unknown | undefined;
  isPassword?: unknown | undefined;
  invokeAvailable?: unknown | undefined;
  isModal?: unknown | undefined;
  semanticRole?: unknown | undefined;
}
interface RawWindow {
  handle?: unknown | undefined;
  rootContainerKey?: unknown | undefined;
  controls?: RawControl[] | undefined;
  className?: unknown | undefined;
  title?: unknown | undefined;
  isMain?: unknown | undefined;
  isModal?: unknown | undefined;
  ownerHandle?: unknown | undefined;
}
interface RawSnapshot extends Omit<UiSnapshot, "windows" | "truncated"> {
  windows: RawWindow[];
  truncated?: unknown | undefined;
}
export const INTENTS = new Set([
  "confirmRequestedUpdate",
  "confirmRequestedSave",
  "cancelUncommittedCommand",
  "dismissKnownInfo",
]);
export const ACTION_FOR_INTENT: Record<string, string> = {
  confirmRequestedUpdate: "confirm",
  confirmRequestedSave: "confirm",
  cancelUncommittedCommand: "cancel",
  dismissKnownInfo: "dismiss",
};

// Source-derived candidates are not universal qualifications. The records below
// are exact same-author native qualifications for one build/OS/locale only.
export const PROFILES: Readonly<Record<string, UiProfile>> = Object.freeze({
  "update-all-latest": Object.freeze({
    intent: "confirmRequestedUpdate",
    action: "confirm",
    commandId: "UpdateAllLatestCmd",
    titleAutomationId: "QTApplication.Nu::QTMessageBox.titleLabel",
    messageAutomationId: "QTApplication.Nu::QTMessageBox.messageLabel",
    buttonAutomationId:
      "QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton",
    localized: {
      pl: {
        title: "Aktualizuj wszystko do najnowszej wersji",
        message: "Spowoduje to zaktualizowanie wszystkich komponent",
        button: "Uaktualnij wszystko",
      },
    },
  }),
  "existing-target-save": Object.freeze({
    intent: "confirmRequestedSave",
    action: "confirm",
    dialogClass: "Nu::QTPLM360LabelDescriptionDialog",
    buttonAutomationId:
      "QTApplication.Nu::QTPLM360LabelDescriptionDialog.QPushButton",
    localized: { pl: { button: "OK" } },
    existingTargetOnly: true,
  }),
  "known-version-error": Object.freeze({
    intent: "dismissKnownInfo",
    action: "dismiss",
    titleAutomationId: "QTApplication.Nu::QTMessageBox.titleLabel",
    messageAutomationId: "QTApplication.Nu::QTMessageBox.messageLabel",
    buttonAutomationId:
      "QTApplication.Nu::QTMessageBox.standardActions.qt_msgbox_buttonbox.QPushButton",
    localized: { pl: { message: "innej wersji", button: "OK" } },
    preservesUnderlyingFailure: true,
  }),
});
export const NATIVE_CANCEL_PROFILE_IDS = Object.freeze([
  "cancel-move",
  "cancel-offset",
]);
export const QUALIFIED_PROFILES: Readonly<Record<string, UiQualification>> =
  Object.freeze({
    "update-all-latest": Object.freeze({
      profileId: "update-all-latest",
      fusionVersion: "2705.1.25",
      osBuild: "10.0.26200.0",
      locale: "pl-PL",
    }),
    "existing-target-save": Object.freeze({
      profileId: "existing-target-save",
      fusionVersion: "2705.1.25",
      osBuild: "10.0.26200.0",
      locale: "pl-PL",
    }),
    "cancel-move": Object.freeze({
      profileId: "cancel-move",
      fusionVersion: "2705.1.25",
      osBuild: "10.0.26200.0",
      locale: "pl-PL",
      commandIds: ["FusionMoveCommand"],
    }),
    "cancel-offset": Object.freeze({
      profileId: "cancel-offset",
      fusionVersion: "2705.1.25",
      osBuild: "10.0.26200.0",
      locale: "pl-PL",
      commandIds: ["FusionOffsetFacesCommand"],
    }),
  });

const INPUTS: Record<string, readonly string[]> = {
  "ui.inspect": ["requestId", "lease", "target", "intent", "maxControls"],
  "ui.respond": [
    "requestId",
    "lease",
    "target",
    "intent",
    "action",
    "observationId",
    "selectionMode",
    "profileId",
    "controlRef",
    "controlName",
    "controlType",
    "containerRef",
    "observedAutomationId",
    "expectedCommandId",
  ],
  "ui.resolve": [
    "requestId",
    "lease",
    "target",
    "intent",
    "allowedProfiles",
    "maxActions",
    "timeBudgetMs",
    "expectedCommandId",
  ],
};
export const operations = Object.keys(INPUTS);

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const digestText = (value: unknown) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const text = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 1024) : "";
export const uuid = () => crypto.randomUUID();

export function validate(operation: string, input: unknown): void {
  const data = input as UiRequest;
  if (!Object.hasOwn(INPUTS, operation)) return;
  if (!object(data)) throw new Error(`${operation} data must be an object`);
  for (const key of Object.keys(data))
    if (!INPUTS[operation]!.includes(key))
      throw new Error(`Unknown ${operation} input: ${key}`);
  if (
    typeof data.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.requestId)
  ) {
    throw new Error(
      "requestId must contain 1..128 letters, digits, underscores or hyphens",
    );
  }
  if (
    !object(data.lease) ||
    Object.keys(data.lease).some(
      (key) =>
        !["id", "requestId", "operationId", "expiresAt", "target"].includes(
          key,
        ),
    ) ||
    typeof data.lease.id !== "string" ||
    !data.lease.id.trim() ||
    data.lease.id.length > 512 ||
    data.lease.requestId !== data.requestId ||
    typeof data.lease.operationId !== "string" ||
    !data.lease.operationId.trim() ||
    !Number.isSafeInteger(data.lease.expiresAt) ||
    !object(data.lease.target)
  ) {
    throw new Error(
      "lease must bind id, requestId, operationId, expiry and target identity",
    );
  }
  if (
    !object(data.target) ||
    Object.keys(data.target).some(
      (key) => !["name", "creationId", "fileId", "commandId"].includes(key),
    ) ||
    typeof data.target.name !== "string" ||
    !data.target.name.trim()
  ) {
    throw new Error(
      "target must contain the exact requested document name and optional identity pins",
    );
  }
  for (const field of ["creationId", "fileId", "commandId"] as const) {
    if (
      data.target[field] !== undefined &&
      (typeof data.target[field] !== "string" || !data.target[field].trim())
    ) {
      throw new Error(`target.${field} must be a nonempty exact value`);
    }
  }
  if (
    Object.keys(data.lease.target).some(
      (key) => !["name", "creationId", "fileId", "commandId"].includes(key),
    ) ||
    data.lease.target.name !== data.target.name ||
    data.lease.target.creationId !== data.target.creationId ||
    data.lease.target.fileId !== data.target.fileId ||
    data.lease.target.commandId !== data.target.commandId
  ) {
    throw new Error("lease target must exactly match the UI request target");
  }
  if (data.intent !== undefined && !INTENTS.has(data.intent!))
    throw new Error("Unknown UI intent");
  if (operation !== "ui.inspect" && !INTENTS.has(data.intent!))
    throw new Error(`${operation} requires an authorized UI intent`);
  if (
    data.expectedCommandId !== undefined &&
    (typeof data.expectedCommandId !== "string" ||
      !data.expectedCommandId.trim())
  ) {
    throw new Error("expectedCommandId must be a nonempty exact command ID");
  }
  if (
    operation === "ui.inspect" &&
    data.maxControls !== undefined &&
    (!Number.isSafeInteger(data.maxControls) ||
      data.maxControls < 1 ||
      data.maxControls > 512)
  ) {
    throw new Error("maxControls must be an integer in 1..512");
  }
  if (operation === "ui.respond") {
    if (
      typeof data.observationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(data.observationId)
    )
      throw new Error("observationId must be a UUID");
    if (data.action !== ACTION_FOR_INTENT[data.intent!])
      throw new Error("action contradicts the authorized intent");
    const mode = data.selectionMode ?? "profile";
    if (!["profile", "observedControl"].includes(mode))
      throw new Error("selectionMode must be profile or observedControl");
    if (mode === "profile" && typeof data.profileId !== "string")
      throw new Error("profileId is required in profile mode");
    const hasRef = typeof data.controlRef === "string";
    const hasName = typeof data.controlName === "string";
    if (mode === "observedControl") {
      if (hasRef === hasName)
        throw new Error(
          "observedControl requires exactly one of controlRef or exact controlName",
        );
      if (
        hasName &&
        (data.controlType !== "Button" || typeof data.containerRef !== "string")
      ) {
        throw new Error(
          "controlName selection requires the exact observed Button type and containerRef",
        );
      }
      if (
        hasRef &&
        ["controlName", "controlType", "containerRef"].some((key) =>
          Object.hasOwn(data, key),
        )
      ) {
        throw new Error(
          "controlRef and name-selector fields are mutually exclusive",
        );
      }
    } else if (
      [
        "controlRef",
        "controlName",
        "controlType",
        "containerRef",
        "observedAutomationId",
      ].some((key) => Object.hasOwn(data, key))
    ) {
      throw new Error(
        "observed-control selectors require selectionMode observedControl",
      );
    }
  }
  if (operation === "ui.resolve") {
    if (
      data.allowedProfiles !== undefined &&
      (!Array.isArray(data.allowedProfiles) ||
        data.allowedProfiles.length > 16 ||
        data.allowedProfiles.some(
          (value) => typeof value !== "string" || !value,
        ))
    )
      throw new Error("allowedProfiles must contain at most 16 profile IDs");
    if (
      data.maxActions !== undefined &&
      (!Number.isSafeInteger(data.maxActions) ||
        data.maxActions < 1 ||
        data.maxActions > 10)
    ) {
      throw new Error("maxActions must be an integer in 1..10");
    }
    if (
      data.timeBudgetMs !== undefined &&
      (!Number.isSafeInteger(data.timeBudgetMs) ||
        data.timeBudgetMs < 1 ||
        data.timeBudgetMs > 120000)
    ) {
      throw new Error("timeBudgetMs must be an integer in 1..120000");
    }
  }
}

export function leaseIsLive(lease: UiLease | undefined, now = Date.now()) {
  return (
    object(lease) &&
    Number.isSafeInteger(lease.expiresAt) &&
    lease.expiresAt > now &&
    typeof lease.id === "string" &&
    typeof lease.requestId === "string" &&
    typeof lease.operationId === "string"
  );
}

export function targetIdentity(
  data: UiRequest,
  context: UiContext,
): UiIdentity {
  const target = data.target;
  if (target.name !== context.doc)
    throw new Error("target.name must exactly match --doc");
  const creationId = target.creationId ?? context.docId ?? null;
  const fileId = target.fileId ?? context.docFileId ?? null;
  if (context.docId && creationId !== context.docId)
    throw new Error("target.creationId conflicts with --doc-id");
  if (context.docFileId && fileId !== context.docFileId)
    throw new Error("target.fileId conflicts with --doc-file-id");
  const commandId = data.expectedCommandId ?? target.commandId ?? null;
  if (
    target.commandId &&
    data.expectedCommandId &&
    target.commandId !== data.expectedCommandId
  ) {
    throw new Error("target.commandId conflicts with expectedCommandId");
  }
  return {
    name: target.name,
    creationId,
    fileId,
    commandId,
    identityPinned: !!(creationId || fileId),
  };
}

export function buildProbe(identity: UiTarget) {
  const request = {
    name: identity.name,
    creationId: identity.creationId,
    fileId: identity.fileId,
  };
  return `import adsk.core, json, os
_FMCAD_UI_TARGET: dict[str, str | None] = ${pythonLiteral(request)}

def run(_context: str) -> None:
    app = adsk.core.Application.get()
    docs = [app.documents.item(i) for i in range(app.documents.count)]
    rows: list[dict[str, object]] = []
    failures: list[str] = []
    for doc in docs:
        try:
            data_file = doc.dataFile
            rows.append({'name': doc.name, 'creationId': doc.creationId,
                'fileId': data_file.id if data_file else None, 'isSaved': bool(doc.isSaved),
                'isModified': bool(doc.isModified), 'isActive': doc == app.activeDocument})
        except Exception as exc:
            failures.append(type(exc).__name__)
    active: str = app.userInterface.activeCommand
    command: dict[str, object] | None = None
    if active:
        try:
            definition = app.userInterface.commandDefinitions.itemById(active)
            command = {'id': active, 'isNative': bool(definition.isNative) if definition else None,
                       'name': definition.name if definition else None}
        except Exception as exc:
            failures.append('commandDefinition:' + type(exc).__name__)
    if failures:
        status = 'unavailable'
        selected = None
    payload: dict[str, object] = {'documents': rows, 'unavailableEvidence': failures,
               'processId': os.getpid(), 'activeCommand': command,
               'fusionVersion': getattr(app, 'version', None)}
    print('FMCAD_UI_PROBE ' + json.dumps(payload, ensure_ascii=False))
`;
}

export function resolveProbeDocuments(probe: UiProbe, identity: UiTarget) {
  const rows = Array.isArray(probe.documents)
    ? probe.documents.filter(object)
    : [];
  const failures = Array.isArray(probe.unavailableEvidence)
    ? probe.unavailableEvidence
    : [];
  const matches = rows.filter(
    (row) =>
      row.name === identity.name &&
      (!identity.creationId || row.creationId === identity.creationId) &&
      (!identity.fileId || row.fileId === identity.fileId),
  );
  const active = matches.filter((row) => row.isActive === true);
  let selected: UiTarget | undefined | null = null,
    candidates = matches,
    status: string;
  if (failures.length) status = "unavailable";
  else if (active.length === 1) {
    selected = active[0];
    candidates = active;
    status = "resolved";
  } else if (active.length > 1 || matches.length > 1) status = "ambiguous";
  else if (matches.length === 1) {
    selected = matches[0];
    status = "resolved";
  } else {
    const byFile = identity.fileId
      ? rows.filter((row) => row.fileId === identity.fileId)
      : [];
    candidates = byFile.length
      ? byFile
      : rows.filter((row) => row.name === identity.name);
    status = candidates.length > 1 ? "ambiguous" : "unavailable";
  }
  return {
    status,
    expected: identity,
    candidates,
    unavailableEvidence: failures,
    processId: probe.processId,
    activeCommand: probe.activeCommand,
    fusionVersion: probe.fusionVersion,
    ...(selected
      ? {
          identity: selected,
          identityPinned: !!(identity.creationId || identity.fileId),
        }
      : {}),
  };
}

export function parseMarked(textValue: unknown, marker: string): unknown {
  const line = String(textValue || "")
    .split(/\r?\n/)
    .find((value) => value.startsWith(marker));
  if (!line) throw new Error(`Missing ${marker.trim()} response`);
  return JSON.parse(line.slice(marker.length));
}

export function decorateSnapshot(input: unknown): UiSnapshot {
  const snapshot = input as RawSnapshot;
  if (!object(snapshot) || !Array.isArray(snapshot.windows))
    return { status: "unavailable", windows: [], truncated: true };
  const truncated =
    snapshot.truncated === true ||
    snapshot.windows.length > 16 ||
    snapshot.windows.some((window) => (window.controls ?? []).length > 256);
  const windows = snapshot.windows.slice(0, 16).map((window) => {
    const handle = Number(window.handle ?? 0);
    const rootKey = String(window.rootContainerKey ?? `root:${handle}`);
    const containerRefs = new Map([[rootKey, uuid()]]);
    const controls = (window.controls ?? []).slice(0, 256).map((control) => {
      const containerKey = String(control.containerKey ?? rootKey);
      if (!containerRefs.has(containerKey))
        containerRefs.set(containerKey, uuid());
      const containerRef = containerRefs.get(containerKey)!;
      const value = {
        windowHandle: handle,
        containerKey,
        runtimeId: Array.isArray(control.runtimeId)
          ? control.runtimeId.map(String)
          : [],
        parentPath: Array.isArray(control.parentPath)
          ? control.parentPath.map(text).slice(0, 12)
          : [],
        automationId: text(control.automationId),
        name: control.isPassword ? "[redacted]" : text(control.name),
        controlType: text(control.controlType),
        className: text(control.className),
        enabled: control.enabled === true,
        offscreen: control.offscreen === true,
        isPassword: control.isPassword === true,
        invokeAvailable: control.invokeAvailable === true,
        isModal: control.isModal === true,
        semanticRole: ["confirm", "cancel", "dismiss"].includes(
          control.semanticRole as string,
        )
          ? (control.semanticRole as string)
          : null,
      };
      return {
        ...value,
        fingerprint: digest(value),
        containerRef,
        controlRef: uuid(),
      };
    });
    return {
      handle,
      className: text(window.className),
      title: text(window.title),
      isMain: window.isMain === true,
      isModal: window.isModal === true,
      ownerHandle: Number(window.ownerHandle ?? 0),
      containerRef: containerRefs.get(rootKey)!,
      containerRefs: [...containerRefs.values()],
      controls,
    };
  });
  return {
    ...snapshot,
    windows,
    truncated,
    controlCount: windows.reduce(
      (sum, window) => sum + window.controls.length,
      0,
    ),
  };
}

export function profileCandidates(
  snapshot: UiSnapshot,
  probe: UiProbe,
  intent: string | null | undefined,
  qualificationRecords: Readonly<Record<string, UiQualification>> = {},
): UiProfileCandidate[] {
  const found: UiProfileCandidate[] = [];
  for (const [profileId, profile] of Object.entries(PROFILES)) {
    if (intent && profile.intent !== intent) continue;
    if (profile.commandId && probe.activeCommand?.id !== profile.commandId)
      continue;
    for (const window of snapshot.windows ?? []) {
      const grouped = new Map<string, UiControl[]>();
      for (const control of window.controls ?? []) {
        const key = control.containerRef ?? window.containerRef;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(control);
      }
      for (const [containerRef, controls] of grouped) {
        const has = (
          automationId: string | undefined,
          controlType: string | undefined,
        ) =>
          controls.filter(
            (control) =>
              control.automationId === automationId &&
              (!controlType || control.controlType === controlType),
          );
        if (
          profile.titleAutomationId &&
          has(profile.titleAutomationId, "Text").length !== 1
        )
          continue;
        if (
          profile.messageAutomationId &&
          has(profile.messageAutomationId, "Text").length !== 1
        )
          continue;
        if (
          profile.dialogClass &&
          !String(window.className).includes(profile.dialogClass!) &&
          !controls.some(
            (control) =>
              String(control.className).includes(profile.dialogClass!) ||
              control.parentPath?.some((part) =>
                part.includes(profile.dialogClass!),
              ),
          )
        )
          continue;
        const buttons = has(profile.buttonAutomationId, "Button").filter(
          (control) =>
            control.enabled && !control.offscreen && control.invokeAvailable,
        );
        const localized =
          profile.localized?.[(snapshot.locale || "").split("-")[0]!];
        if (
          localized?.title &&
          !has(profile.titleAutomationId, "Text").some(
            (control) => control.name === localized.title,
          )
        )
          continue;
        if (
          localized?.message &&
          !has(profile.messageAutomationId, "Text").some((control) =>
            control.name.includes(localized.message!),
          )
        )
          continue;
        if (
          profile.existingTargetOnly &&
          (!probe.identity?.isSaved || !probe.identity?.fileId)
        )
          continue;
        const localizedButtons = localized
          ? buttons.filter((control) => control.name === localized.button)
          : [];
        const invariantButtons = buttons.filter(
          (control) => control.semanticRole === profile.action,
        );
        const selected =
          invariantButtons.length === 1 ? invariantButtons : localizedButtons;
        for (const control of selected) {
          const qualification = qualificationRecords[profileId];
          const qualified =
            !!qualification &&
            qualification.fusionVersion === probe.fusionVersion &&
            qualification.osBuild === snapshot.osBuild &&
            qualification.locale === snapshot.locale &&
            qualification.profileId === profileId;
          found.push({
            profileId,
            intent: profile.intent,
            action: profile.action,
            matchingMethod:
              invariantButtons.length === 1
                ? "invariantIds"
                : "localizedProfile",
            languageIndependent: invariantButtons.length === 1,
            actualLocale: snapshot.locale ?? null,
            qualified,
            qualification: qualified ? qualification : null,
            windowHandle: window.handle,
            containerRef,
            controlRef: control.controlRef,
            controlName: control.name,
            controlType: control.controlType,
            automationId: control.automationId,
            fingerprint: control.fingerprint,
            preservesUnderlyingFailure:
              profile.preservesUnderlyingFailure === true,
            requiredCommandId: profile.commandId ?? null,
            nativeCommandId: null,
          });
        }
      }
    }
  }
  // Native cancellation candidates require an explicit qualified runtime command-ID mapping.
  if (
    intent === "cancelUncommittedCommand" &&
    probe.activeCommand?.isNative === true
  ) {
    for (const profileId of NATIVE_CANCEL_PROFILE_IDS) {
      const qualification = qualificationRecords[profileId];
      if (
        !qualification ||
        qualification.fusionVersion !== probe.fusionVersion ||
        qualification.osBuild !== snapshot.osBuild ||
        qualification.locale !== snapshot.locale ||
        !Array.isArray(qualification.commandIds) ||
        !qualification.commandIds.includes(probe.activeCommand.id)
      )
        continue;
      found.push({
        profileId,
        intent,
        action: "cancel",
        qualified: true,
        qualification,
        matchingMethod: "nativeCommand",
        languageIndependent: true,
        nativeCommandId: probe.activeCommand.id,
        commandIds: qualification.commandIds,
        controlRef: null,
        windowHandle: null,
      });
    }
  }
  return found;
}

export function exactControl(record: { windows: UiWindow[] }, data: UiRequest) {
  const controls = record.windows.flatMap((window) => window.controls);
  if (data.controlRef) {
    const matches = controls.filter(
      (control) => control.controlRef === data.controlRef,
    );
    return {
      status:
        matches.length === 1
          ? "selected"
          : matches.length > 1
            ? "ambiguous"
            : "notFound",
      candidates: matches,
      control: matches.length === 1 ? matches[0] : null,
    };
  }
  const scopedControls = record.windows
    .flatMap((window) => window.controls)
    .filter((control) => control.containerRef === data.containerRef);
  if (!scopedControls.length) return { status: "notFound", candidates: [] };
  const matches = scopedControls.filter(
    (control) =>
      control.controlType === "Button" &&
      control.name === data.controlName &&
      (data.observedAutomationId === undefined ||
        control.automationId === data.observedAutomationId),
  );
  return {
    status:
      matches.length === 1
        ? "selected"
        : matches.length
          ? "ambiguous"
          : "notFound",
    candidates: matches,
    control: matches.length === 1 ? matches[0] : null,
  };
}

export function structuralDialogs(
  snapshot: UiSnapshot,
  probe: UiProbe,
  intent: string | undefined,
) {
  const matches = [];
  for (const [profileId, profile] of Object.entries(PROFILES)) {
    if (
      profile.intent !== intent ||
      (profile.commandId && probe.activeCommand?.id !== profile.commandId) ||
      (profile.existingTargetOnly &&
        (!probe.identity?.isSaved || !probe.identity?.fileId))
    )
      continue;
    for (const window of snapshot.windows ?? []) {
      const groups = new Map<string, UiControl[]>();
      for (const control of window.controls ?? []) {
        const key = control.containerRef ?? window.containerRef;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(control);
      }
      for (const [containerRef, controls] of groups) {
        const hasUnique = (id: string | undefined) =>
          !id ||
          controls.filter((control) => control.automationId === id).length ===
            1;
        if (
          !hasUnique(profile.titleAutomationId) ||
          !hasUnique(profile.messageAutomationId) ||
          (profile.dialogClass &&
            !String(window.className).includes(profile.dialogClass!) &&
            !controls.some(
              (control) =>
                String(control.className).includes(profile.dialogClass!) ||
                control.parentPath?.some((part) =>
                  part.includes(profile.dialogClass!),
                ),
            )) ||
          !controls.some(
            (control) =>
              control.automationId === profile.buttonAutomationId &&
              control.controlType === "Button",
          )
        )
          continue;
        matches.push({
          profileId,
          intent: profile.intent,
          action: profile.action,
          windowHandle: window.handle,
          containerRef,
          preservesUnderlyingFailure:
            profile.preservesUnderlyingFailure === true,
          matchingMethod: "callerSelected",
          languageIndependent: false,
          qualified: false,
        });
      }
    }
  }
  return matches;
}
