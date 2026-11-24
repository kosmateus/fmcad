import { spawn } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { controlledLegacyUiNative } from "./controlled-legacy-ui-native";
import {
  readLegacyUiCapture,
  requireLegacyEntry,
  oneLegacyControl,
  visibleLegacyControl,
  type LegacyUiCapture,
} from "./controlled-legacy-ui-contract";
import {
  readControlledMappedBytes,
  type ControlledHostUiLease,
} from "./controlled-host-ui";
import { matchesControlledFusionAutoload } from "./fusion-bootstrap-autoload";
import { readControlledUiEntryIntentV2 } from "./controlled-ui-intent-v2";
import type {
  ControlledFile,
  ControlledNativeAdapter,
  ControlledProcess,
} from "./controlled-fusion-launch-types";

type Ref = Pick<ControlledFile, "nativePath" | "identity" | "sha256">;
export interface ControlledLegacyUiPins {
  readonly powershell: string;
  readonly mappedPowershell: string;
  readonly powershellSha256: string;
  readonly powershellConfigSha256: string;
  readonly executable: string;
  readonly executableSha256: string;
  /** Original native identities/hashes of the installed vendor UI libraries. */
  readonly vendorFiles: readonly Ref[];
  readonly auditDirectory: string;
}
type Action =
  | "openPreferences"
  | "selectApi"
  | "toggleLegacy"
  | "applyLegacy"
  | "cancelPreferences"
  | "openManager"
  | "addinsTab"
  | "details"
  | "selectEntry"
  | "closeManager"
  | "start";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (x: unknown) => Buffer.from(JSON.stringify(x) + "\n");
const ref = (x: ControlledFile): Ref => ({
  nativePath: x.nativePath,
  identity: x.identity,
  sha256: x.sha256,
});
const samePath = (a: string, b: string) =>
  path.win32.normalize(a).toLowerCase() ===
  path.win32.normalize(b).toLowerCase();
const fingerprint = (c: LegacyUiCapture) => ({
  process: c.process,
  mainHwnd: c.mainHwnd,
  mode: c.mode,
  dialogHwnd: c.dialogHwnd,
  controls: c.controls,
  treeSelection: c.treeSelection,
});
function sync(f: () => void) {
  const result: unknown = f();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Synchronous held legacy UI lease fence required");
  }
}
/** Finite private native original whitelist, including immutable O_EXCL dispatches. */
export function controlledLegacyUiAuditPaths(
  directory: string,
  intent: string,
): readonly string[] {
  return Object.freeze([
    ...Array.from({ length: 64 }, (_, i) =>
      ["json", "png"].map((ext) =>
        path.win32.join(directory, `${i}-capture.${ext}`),
      ),
    ).flat(),
    ...Array.from({ length: 32 }, (_, i) =>
      ["json", "json.dispatch"].map((ext) =>
        path.win32.join(directory, `${i}-attempt.${ext}`),
      ),
    ).flat(),
    ...[
      "original-setting.json",
      "restored-setting.json",
      "prepared.json",
      "start-delivered.json",
    ].map((n) => path.win32.join(directory, n)),
    `${intent}.legacy-start-attempt.json`,
    `${intent}.legacy-start-attempt.json.dispatch`,
  ]);
}
/** Compression only avoids Windows' 32766-character command line limit. */
export function encodedLegacyUiProgram(): string {
  const packed = gzipSync(
    Buffer.from(controlledLegacyUiNative, "utf8"),
  ).toString("base64");
  const boot = `$m=New-Object IO.MemoryStream(,[Convert]::FromBase64String('${packed}'));$z=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Decompress);$s=New-Object IO.StreamReader($z,[Text.Encoding]::UTF8);try{$c=$s.ReadToEnd()}finally{$s.Dispose();$m.Dispose()};$h=[Security.Cryptography.SHA256]::Create();try{$v=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($c)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};if($v -cne '${sha(Buffer.from(controlledLegacyUiNative))}'){throw 'Pinned legacy program bytes differ'};& ([ScriptBlock]::Create($c))`;
  return Buffer.from(boot, "utf16le").toString("base64");
}
function preference(c: LegacyUiCapture) {
  if (c.mode !== "preferences")
    throw new Error("Actual API Preferences required");
  oneLegacyControl(
    c,
    (x) =>
      x.name === "API" &&
      x.type === "ControlType.TreeItem" &&
      x.selected === true,
  );
  const label = visibleLegacyControl(
    oneLegacyControl(
      c,
      (x) =>
        x.name === "Starsze okno dialogowe Skrypty" && x.class === "QLabel",
    ),
  );
  const parent = c.controls.find((x) => x.runtimeId === label.parent);
  if (
    !parent ||
    !/^QTApplication\.Nu::QTPreferencesDialog\.QFrame\.scrollArea\d+\.qt_scrollarea_viewport\.BaseWidget\d+$/.test(
      parent.id,
    )
  )
    throw new Error("Exact legacy preference label parent required");
  const box = visibleLegacyControl(
    oneLegacyControl(
      c,
      (x) =>
        x.parent === label.parent &&
        x.class === "QCheckBox" &&
        x.type === "ControlType.CheckBox" &&
        x.x !== null &&
        x.y !== null &&
        label.x !== null &&
        label.y !== null &&
        x.x >= label.x + label.width &&
        x.x - label.x - label.width <= 30 &&
        Math.abs(x.y + x.height / 2 - label.y - label.height / 2) <= 2,
    ),
  );
  if (box.toggle !== "On" && box.toggle !== "Off")
    throw new Error("Original ToggleState required");
  const apply = oneLegacyControl(
    c,
    (x) => x.name === "Zastosuj" && x.class === "QPushButton",
  );
  return { box, apply, state: box.toggle };
}
function onlyPreferenceDelta(before: LegacyUiCapture, after: LegacyUiCapture) {
  const { box, apply } = preference(before);
  const copy = structuredClone(after);
  for (const x of copy.controls) {
    const original = before.controls.find((y) => y.runtimeId === x.runtimeId);
    if (!original) throw new Error("Preferences hierarchy changed");
    if (x.runtimeId === box.runtimeId) x.toggle = original.toggle;
    if (x.runtimeId === apply.runtimeId) x.enabled = original.enabled;
  }
  if (!isDeepStrictEqual(fingerprint(before), fingerprint(copy)))
    throw new Error("Unexpected preference/source UI change");
}

function apiValues(c: LegacyUiCapture) {
  const { box } = preference(c);
  const inside = (x: (typeof c.controls)[number]): boolean =>
    x.runtimeId === box.parent ||
    (x.parent !== null &&
      (x.parent === box.parent ||
        inside(c.controls.find((y) => y.runtimeId === x.parent)!)));
  return c.controls
    .filter((x) => inside(x) && (x.value !== null || x.toggle !== null))
    .map((x) => ({
      id: x.id.replace(/(scrollArea|BaseWidget)\d+/g, "$1#"),
      class: x.class,
      type: x.type,
      value: x.value,
      readOnly: x.readOnly,
      toggle: x.toggle,
    }));
}

/**
 * Separate vendor-pinned legacy port, not a WPF DTO translation.
 * ROOT supplies the real held lifecycle lease and original native adapter.
 * Observe/prepare data never authorizes SDK; Start needs original isolated intent.
 * restorePresentation is mandatory in the caller's finally block, including DENY.
 */
export function createControlledLegacyHostUi(
  options: ControlledLegacyUiPins,
  native: ControlledNativeAdapter,
  lease: ControlledHostUiLease,
) {
  const pins = structuredClone(options);
  const entry = path.win32.join(
    native.installedDirectory,
    "AutodeskFusionMCP.py",
  );
  const manifest = path.win32.join(
    native.installedDirectory,
    "AutodeskFusionMCP.manifest",
  );
  const source = Object.freeze({
    directory: native.installedDirectory,
    source: native.installedSource,
    files: structuredClone(native.installedFiles),
  });
  const program = encodedLegacyUiProgram();
  const canonical = (p: string) =>
    /^[A-Za-z]:\\/.test(p) &&
    path.win32.normalize(p) === p &&
    !p.includes("\0");
  const relativeAudit = path.win32.relative(
    source.directory,
    pins.auditDirectory,
  );
  if (
    Object.keys(pins).sort().join() !==
      "auditDirectory,executable,executableSha256,mappedPowershell,powershell,powershellConfigSha256,powershellSha256,vendorFiles" ||
    !canonical(pins.powershell) ||
    !canonical(pins.executable) ||
    !canonical(pins.auditDirectory) ||
    !path.isAbsolute(pins.mappedPowershell) ||
    program.length + pins.powershell.length + 128 > 32766 ||
    ![
      pins.powershellSha256,
      pins.powershellConfigSha256,
      pins.executableSha256,
    ].every((h) => /^[a-f0-9]{64}$/.test(h)) ||
    pins.vendorFiles.length !== 2 ||
    !["NuBase10.dll", "XLayerUI10.dll"].every((n) =>
      pins.vendorFiles.some(
        (f) =>
          Object.keys(f).sort().join() === "identity,nativePath,sha256" &&
          canonical(f.nativePath) &&
          path.win32.basename(f.nativePath) === n &&
          f.nativePath ===
            path.win32.join(path.win32.dirname(pins.executable), n) &&
          /^[a-f0-9]{64}$/.test(f.sha256) &&
          f.identity.length > 0,
      ),
    ) ||
    !["AutodeskFusionMCP.py", "AutodeskFusionMCP.manifest"].every((n) =>
      /^[a-f0-9]{64}$/.test(source.files[n] ?? ""),
    ) ||
    !(
      relativeAudit === ".." ||
      relativeAudit.startsWith("..\\") ||
      path.win32.isAbsolute(relativeAudit)
    )
  )
    throw new Error(
      "Closed pinned legacy OS/vendor/source/audit configuration required",
    );
  let busy = false,
    poisoned = false,
    prepared = false,
    started = false;
  let restoring = false;
  let restorationConflict = false;
  let process: ControlledProcess | undefined, mainHwnd: string | undefined;
  let originalSetting: "On" | "Off" | undefined;
  let originalApiValues: ReturnType<typeof apiValues> | undefined;
  let ownManager: string | undefined, ownPreferences: string | undefined;
  let preparedManager:
    { mainHwnd: string; dialogHwnd: string; runtimeId: string } | undefined;
  function requirePreparedManager(c: LegacyUiCapture) {
    if (
      !preparedManager ||
      c.mode !== "manager" ||
      c.mainHwnd !== preparedManager.mainHwnd ||
      c.dialogHwnd !== preparedManager.dialogHwnd ||
      c.dialogHwnd !== ownManager ||
      c.controls[0]?.runtimeId !== preparedManager.runtimeId
    )
      throw new Error("Original prepared manager HWND/context changed");
  }
  let captures = 0,
    attempts = 0;
  const originals: ControlledFile[] = [];
  let sourceFiles: ControlledFile[] = [];
  let mappedFence: (() => void) | undefined;
  let mappedCount = -1;
  function fence() {
    if (poisoned && !restoring)
      throw new Error("Legacy outcome revoked; no retry/replay");
    sync(() => lease.fence());
    readControlledMappedBytes(pins.mappedPowershell, pins.powershellSha256);
    readControlledMappedBytes(
      `${pins.mappedPowershell}.config`,
      pins.powershellConfigSha256,
    );
    mappedFence?.();
    if (mappedCount !== sourceFiles.length + originals.length) {
      mappedFence = native.captureSynchronousFence([
        ...sourceFiles,
        ...originals,
      ]);
      mappedCount = sourceFiles.length + originals.length;
    }
    sync(mappedFence!);
    sync(() => lease.fence());
  }
  async function current() {
    fence();
    await lease.assertCurrent();
    fence();
    await native.assertSource();
    fence();
    if (!process) throw new Error("Original UI process not bound");
    await native.assertProcess(process);
    fence();
    for (const f of [...sourceFiles, ...originals]) {
      await native.assertOriginal(f);
      fence();
    }
    await lease.assertCurrent();
    fence();
  }
  async function publish(name: string, value: unknown, png = false) {
    await current();
    const nativePath = path.win32.join(pins.auditDirectory, name);
    if (!native.nativePathMappings[nativePath])
      throw new Error("Explicit private original audit mapping required");
    const content = png ? Buffer.from(value as string, "base64") : bytes(value);
    const f = await native.publishOriginal(nativePath, content);
    fence();
    if (
      f.nativePath !== nativePath ||
      f.sha256 !== sha(content) ||
      sha(f.bytes) !== f.sha256 ||
      !Buffer.from(f.bytes).equals(content)
    )
      throw new Error("Original private audit bytes differ");
    originals.push(Object.freeze({ ...f, bytes: Buffer.from(f.bytes) }));
    await native.assertOriginal(f);
    fence();
    return f;
  }
  async function invoke(
    action: Action | "capture",
    expected?: LegacyUiCapture,
    attempt?: ControlledFile,
    intent?: ControlledFile,
    profile?: ControlledFile,
  ) {
    await current();
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        pins.mappedPowershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          program,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "",
        overflow = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error("Legacy OS helper timeout; outcome UNKNOWN, no replay"),
        );
      }, 90_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (s: string) => {
        if (stdout.length + s.length <= 32 * 1024 * 1024) stdout += s;
        else overflow = true;
      });
      child.stderr.on("data", (s: string) => {
        if (stderr.length + s.length <= 1024 * 1024) stderr += s;
        else overflow = true;
      });
      child.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.stdin.on("error", () => {
        /* no resend */
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0 || overflow)
          reject(new Error(`Legacy OS helper DENY/UNKNOWN: ${stderr}`));
        else resolve(stdout);
      });
      try {
        fence();
        child.stdin.end(
          bytes({
            ...pins,
            process,
            action,
            expected: expected ?? null,
            preparedManager: action === "start" ? preparedManager : null,
            entry,
            originals: sourceFiles.map(ref),
            attempt: attempt ? ref(attempt) : null,
            intent: intent ? ref(intent) : null,
            profile: profile ? ref(profile) : null,
            dispatchPath: attempt ? `${attempt.nativePath}.dispatch` : null,
            legacyBefore:
              action === "toggleLegacy" && expected
                ? preference(expected).state
                : null,
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        child.kill();
        reject(error);
      }
    });
    await current();
    const response = decodeAdmissionJson(raw) as {
      capture: unknown;
      inputDelivered: boolean;
    };
    if (
      !response ||
      Object.keys(response).sort().join() !== "capture,inputDelivered" ||
      response.inputDelivered !== (action !== "capture")
    )
      throw new Error("Partial original legacy OS response");
    const c = readLegacyUiCapture(JSON.stringify(response.capture), process!);
    if (prepared && !restoring) requirePreparedManager(c);
    if (mainHwnd !== undefined && c.mainHwnd !== mainHwnd)
      throw new Error("Original HWND changed");
    mainHwnd ??= c.mainHwnd;
    return c;
  }
  async function observe() {
    if (captures >= 64) throw new Error("Bounded legacy observation exhausted");
    const c = await invoke("capture"),
      i = captures++;
    const image = c.image
      ? await publish(`${i}-capture.png`, c.image.png, true)
      : null;
    const reference = await publish(`${i}-capture.json`, {
      kind: "controlled-legacy-ui-observation-v1",
      authority: "NONE",
      capture: c,
      image: image ? ref(image) : null,
    });
    return { capture: c, reference };
  }
  async function act(
    action: Action,
    before: LegacyUiCapture,
    intent?: ControlledFile,
    profile?: ControlledFile,
  ) {
    if (attempts >= 32) throw new Error("Bounded legacy input exhausted");
    if (action === "start") requirePreparedManager(before);
    await current();
    const nativePath =
      action === "start"
        ? `${intent!.nativePath}.legacy-start-attempt.json`
        : path.win32.join(pins.auditDirectory, `${attempts++}-attempt.json`);
    if (
      !native.nativePathMappings[nativePath] ||
      !native.nativePathMappings[`${nativePath}.dispatch`]
    )
      throw new Error("Original durable dispatch mapping required");
    const attemptBytes = bytes({
      kind: "controlled-legacy-ui-attempt-v1",
      authority: "NONE",
      action,
      process,
      observation: fingerprint(before),
      intent: intent ? ref(intent) : null,
    });
    const attempt = await native.publishOriginal(nativePath, attemptBytes);
    fence();
    if (
      attempt.nativePath !== nativePath ||
      attempt.sha256 !== sha(attemptBytes) ||
      !Buffer.from(attempt.bytes).equals(attemptBytes)
    )
      throw new Error("Original attempt differs");
    originals.push(
      Object.freeze({ ...attempt, bytes: Buffer.from(attempt.bytes) }),
    );
    const delivered = await invoke(action, before, attempt, intent, profile);
    if (!isDeepStrictEqual(fingerprint(delivered), fingerprint(before)))
      throw new Error("Original dispatch observation changed");
    const dispatch = await native.readOriginal(`${nativePath}.dispatch`);
    fence();
    originals.push(
      Object.freeze({ ...dispatch, bytes: Buffer.from(dispatch.bytes) }),
    );
    return observe();
  }
  async function bind(request: { process: ControlledProcess; entry: string }) {
    if (
      Object.keys(request).sort().join() !== "entry,process" ||
      Object.keys(request.process).sort().join() !== "birth,pid" ||
      process ||
      !samePath(request.entry, entry)
    )
      throw new Error("Original process/entry already bound");
    process = Object.freeze({ ...request.process });
    await current();
    const read = await Promise.all(
      [entry, manifest].map((p) => native.readOriginal(p)),
    );
    sourceFiles = read.map((f) =>
      Object.freeze({ ...f, bytes: Buffer.from(f.bytes) }),
    );
    fence();
    if (
      sourceFiles.some(
        (f) =>
          f.sha256 !== source.files[path.win32.basename(f.nativePath)] ||
          sha(f.bytes) !== f.sha256,
      ) ||
      !samePath(sourceFiles[0]!.nativePath, entry) ||
      !samePath(sourceFiles[1]!.nativePath, manifest)
    )
      throw new Error("Original installed entry/manifest identity differs");
    await current();
  }
  async function preferencesOpen() {
    let view = await observe();
    if (view.capture.mode === "main") {
      view = await act("openPreferences", view.capture);
      if (view.capture.mode !== "preferences")
        throw new Error("Preferences open unobserved");
      ownPreferences = view.capture.dialogHwnd!;
    }
    if (
      view.capture.mode !== "preferences" ||
      ownPreferences !== view.capture.dialogHwnd
    )
      throw new Error("Only own Preferences may change");
    if (
      !view.capture.controls.some(
        (x) =>
          x.name === "API" &&
          x.type === "ControlType.TreeItem" &&
          x.selected === true,
      )
    )
      view = await act("selectApi", view.capture);
    return view;
  }
  async function setOption(
    view: Awaited<ReturnType<typeof observe>>,
    target: "On" | "Off",
  ) {
    const before = preference(view.capture);
    if (before.apply.enabled)
      throw new Error("Foreign pending preference changes");
    if (before.state === target) return view;
    const changed = await act("toggleLegacy", view.capture);
    onlyPreferenceDelta(view.capture, changed.capture);
    if (
      preference(changed.capture).state !== target ||
      !preference(changed.capture).apply.enabled
    )
      throw new Error("Normal UI legacy toggle not applied; no blind retry");
    const applied = await act("applyLegacy", changed.capture);
    onlyPreferenceDelta(changed.capture, applied.capture);
    if (
      preference(applied.capture).state !== target ||
      preference(applied.capture).apply.enabled
    )
      throw new Error("Legacy Apply postcondition UNKNOWN");
    return applied;
  }
  async function exclusive<T>(operation: () => Promise<T>, cleanup = false) {
    if (busy || (poisoned && !cleanup)) {
      poisoned = true;
      throw new Error("Legacy outcome revoked; no retry/replay");
    }
    busy = true;
    restoring = cleanup;
    try {
      return await operation();
    } catch (e) {
      poisoned = true;
      throw e;
    } finally {
      busy = false;
      restoring = false;
    }
  }
  return Object.freeze({
    /** No UI input, no prepared/start capability; emits original observation then DENY if unqualified. */
    inspectExactHost: (request: {
      process: ControlledProcess;
      entry: string;
    }) =>
      exclusive(async () => {
        await bind(request);
        const view = await observe();
        requireLegacyEntry(view.capture, entry);
        return {
          process: process!,
          selectedEntry: entry,
          reference: view.reference,
        };
      }),
    prepareExactHost: (request: {
      process: ControlledProcess;
      entry: string;
    }) =>
      exclusive(async () => {
        await bind(request);
        const initial = await observe();
        if (initial.capture.mode !== "main")
          throw new Error("Owned main-only UI preparation required");
        let prefs = await preferencesOpen();
        const original = preference(prefs.capture);
        if (original.apply.enabled)
          throw new Error("Foreign pending Preferences changes");
        originalSetting = original.state;
        originalApiValues = apiValues(prefs.capture);
        await publish("original-setting.json", {
          kind: "legacy-presentation-original-v1",
          authority: "NONE",
          process,
          state: originalSetting,
          apiValues: originalApiValues,
          observation: ref(prefs.reference),
        });
        prefs = await setOption(prefs, "On");
        const closed = await act("cancelPreferences", prefs.capture);
        if (closed.capture.mode !== "main")
          throw new Error("Preferences close unobserved");
        ownPreferences = undefined;
        let manager = await act("openManager", closed.capture);
        if (manager.capture.mode !== "manager")
          throw new Error("Legacy manager unavailable; no restart allowed");
        ownManager = manager.capture.dialogHwnd!;
        if (
          !manager.capture.controls.some(
            (x) =>
              x.name === "Dodatki" &&
              x.type === "ControlType.TabItem" &&
              x.selected === true,
          )
        )
          manager = await act("addinsTab", manager.capture);
        if (
          !manager.capture.controls.some(
            (x) => x.name === "Pełna ścieżka" && x.class === "QLabel",
          )
        )
          manager = await act("details", manager.capture);
        manager = await act("selectEntry", manager.capture);
        requireLegacyEntry(manager.capture, entry);
        if (manager.capture.dialogHwnd !== ownManager)
          throw new Error("Owned manager HWND changed during preparation");
        preparedManager = {
          mainHwnd: manager.capture.mainHwnd,
          dialogHwnd: ownManager,
          runtimeId: manager.capture.controls[0]!.runtimeId,
        };
        const reference = await publish("prepared.json", {
          kind: "legacy-ui-prepared-v1",
          authority: "NONE",
          process,
          selectedEntry: entry,
          observation: ref(manager.reference),
        });
        prepared = true;
        return { process: process!, selectedEntry: entry, reference };
      }),
    startReviewedFork: (request: {
      process: ControlledProcess;
      entry: string;
      intent: ControlledFile;
    }) =>
      exclusive(async () => {
        if (
          !prepared ||
          started ||
          !isDeepStrictEqual(request.process, process) ||
          !samePath(request.entry, entry)
        )
          throw new Error("Original prepared legacy process/entry required");
        started = true;
        const intent = Object.freeze({
          ...request.intent,
          bytes: Buffer.from(request.intent.bytes),
        });
        if (
          intent.nativePath !== native.paths.intent ||
          sha(intent.bytes) !== intent.sha256
        )
          throw new Error("Original isolated stdout intent required");
        await native.assertOriginal(intent);
        fence();
        const v = readControlledUiEntryIntentV2(
          Buffer.from(intent.bytes).toString("utf8"),
        );
        if (
          !v ||
          Object.keys(v).sort().join() !==
            "engineVersion,executable,installed,kind,nonce,process,profile,purpose,receipts,version" ||
          v.kind !== "fmcad-bootstrap-entry-intent" ||
          v.version !== 2 ||
          v.engineVersion !== 2 ||
          v.purpose !== "isolated-stdout-v1" ||
          !/^[a-f0-9]{32}$/.test(v.nonce) ||
          !isDeepStrictEqual(v.executable, {
            path: pins.executable,
            sha256: pins.executableSha256,
          }) ||
          !isDeepStrictEqual(v.process, process) ||
          v.installed?.directory !== source.directory ||
          v.installed.source !== source.source ||
          !isDeepStrictEqual(v.installed.files, source.files) ||
          v.profile?.path !== native.paths.profile ||
          !isDeepStrictEqual(v.receipts, {
            directory: native.paths.receiptDirectory,
            entry: path.win32.basename(native.paths.entry),
            returned: path.win32.basename(native.paths.returned),
          })
        )
          throw new Error("Exact isolated intent/source/receipts differ");
        // Always reread: GUI can replace identical profile bytes with a NEW File ID.
        const profile = await native.readOriginal(native.paths.profile);
        fence();
        if (
          v.profile.sha256 !== profile.sha256 ||
          sha(profile.bytes) !== profile.sha256 ||
          !matchesControlledFusionAutoload(profile.bytes, entry)
        )
          throw new Error("Fresh original ALL-OFF profile required");
        const view = await observe();
        requirePreparedManager(view.capture);
        requireLegacyEntry(view.capture, entry);
        await native.assertOriginal(intent);
        fence();
        await native.assertOriginal(profile);
        fence();
        const delivered = await act("start", view.capture, intent, profile);
        const reference = await publish("start-delivered.json", {
          kind: "legacy-ui-input-observation-v1",
          authority: "NONE",
          process,
          intent: ref(intent),
          profile: ref(profile),
          observation: ref(delivered.reference),
          inputDelivered: true,
          startupProven: false,
        });
        return { process: process!, selectedEntry: entry, reference };
      }),
    restorePresentation: () =>
      exclusive(async () => {
        if (restorationConflict)
          throw new Error(
            "External API preference delta retained; no overwrite or false restore",
          );
        if (!process) throw new Error("No original UI process");
        let view = await observe();
        if (ownManager && view.capture.mode === "manager") {
          if (preparedManager) requirePreparedManager(view.capture);
          if (view.capture.dialogHwnd !== ownManager)
            throw new Error("Owned manager HWND changed");
          view = await act("closeManager", view.capture);
          if (view.capture.mode !== "main")
            throw new Error("Owned manager close unobserved");
          ownManager = undefined;
        }
        if (ownManager && view.capture.mode !== "manager")
          throw new Error("Owned manager disposition UNKNOWN");
        if (originalSetting !== undefined) {
          const prefs = await preferencesOpen();
          const restored = await setOption(prefs, originalSetting);
          const valuesRestored = isDeepStrictEqual(
            apiValues(restored.capture),
            originalApiValues,
          );
          await publish("restored-setting.json", {
            kind: "legacy-presentation-restored-v1",
            authority: "NONE",
            process,
            state: preference(restored.capture).state,
            apiValuesRestored: valuesRestored,
            observation: ref(restored.reference),
          });
          view = await act("cancelPreferences", restored.capture);
          if (view.capture.mode !== "main")
            throw new Error("Restored Preferences close unobserved");
          ownPreferences = undefined;
          originalSetting = undefined;
          originalApiValues = undefined;
          if (!valuesRestored) {
            restorationConflict = true;
            throw new Error(
              "Unexpected API preference delta; original legacy bool restored, no overwrite",
            );
          }
        } else if (ownPreferences && view.capture.mode === "preferences") {
          if (view.capture.dialogHwnd !== ownPreferences)
            throw new Error("Owned Preferences HWND changed");
          view = await act("cancelPreferences", view.capture);
          if (view.capture.mode !== "main")
            throw new Error("Owned Preferences close unobserved");
          ownPreferences = undefined;
        }
        if (ownManager || ownPreferences)
          throw new Error("Presentation cleanup remains UNKNOWN");
        prepared = false;
        return { restored: true as const, reference: view.reference };
      }, true),
  });
}
