import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inflateSync } from "node:zlib";
import { decodeAdmissionJson } from "./admission-json";
import { controlledHostUiNative } from "./controlled-host-ui-native";
import { ControlledFusionNativeError } from "./controlled-fusion-launch";
import type { BootstrapEntryIntent } from "./bootstrap-entry-evidence";
import { matchesControlledFusionAutoload } from "./fusion-bootstrap-autoload";
import type {
  ControlledFile,
  ControlledNativeAdapter,
  ControlledProcess,
} from "./controlled-fusion-launch-types";

export interface ControlledUiSelector {
  readonly id: string;
  readonly name: string;
  readonly class: string;
  readonly type: string;
}
export interface ControlledHostUiPins {
  readonly powershell: string;
  readonly mappedPowershell: string;
  readonly powershellSha256: string;
  readonly powershellConfigSha256: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly mainClass: string;
  readonly openManager: ControlledUiSelector;
  readonly installedEntry: ControlledUiSelector;
  readonly start: ControlledUiSelector;
  /** Fresh, private native paths, included in native.originalPaths/mappings. */
  readonly auditDirectory: string;
  readonly mappedAuditDirectory: string;
}
export interface ControlledHostUiLease {
  fence(): void;
  assertCurrent(): Promise<void>;
}
interface View {
  process: ControlledProcess;
  hwnd: string;
  main: Record<string, unknown>;
  tree: Array<Record<string, unknown>>;
  selectedEntry: string | null;
}
interface Capture {
  view: View;
  png: string;
  inputDelivered: boolean;
}
function validateImage(png: Buffer, view: View) {
  if (
    png.length < 57 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("Original screenshot missing/partial");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width * height > 16777216 ||
    width !== Math.trunc(Number(view.main["width"])) ||
    height !== Math.trunc(Number(view.main["height"])) ||
    png[24] !== 8 ||
    ![2, 6].includes(png[25]!) ||
    png[26] !== 0 ||
    png[27] !== 0 ||
    png[28] !== 0
  )
    throw new Error(
      "Original full-window screenshot dimensions/encoding differ",
    );
  const data: Buffer[] = [];
  let ended = false;
  for (let offset = 8, index = 0; offset < png.length; index++) {
    if (offset + 12 > png.length) throw new Error("Partial PNG chunk");
    const size = png.readUInt32BE(offset),
      type = png.toString("ascii", offset + 4, offset + 8);
    if (
      offset + 12 + size > png.length ||
      (index === 0 && (type !== "IHDR" || size !== 13))
    )
      throw new Error("Partial PNG original");
    if (type === "IDAT") data.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
    if (type === "IEND") {
      if (size !== 0 || offset !== png.length)
        throw new Error("PNG trailing/partial bytes");
      ended = true;
    }
  }
  if (!ended || data.length === 0) throw new Error("Incomplete original PNG");
  const stride = 1 + width * (png[25] === 6 ? 4 : 3),
    size = stride * height;
  const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: size });
  if (decoded.length !== size) throw new Error("Partial screenshot pixels");
  for (let i = 0; i < height; i++)
    if (decoded[i * stride]! > 4) throw new Error("Invalid PNG pixel row");
}
function validateView(view: View) {
  const keys =
    "class,enabled,height,id,index,name,offscreen,selected,type,width,x,y";
  if (
    Object.keys(view).sort().join() !==
      "hwnd,main,process,selectedEntry,tree" ||
    view.tree.length > 4096
  )
    throw new Error("Partial closed UI view");
  for (const [index, item] of [
    [-1, view.main],
    ...view.tree.map((item, i) => [i, item]),
  ] as Array<[number, Record<string, unknown>]>) {
    if (
      !item ||
      Object.keys(item).sort().join() !== keys ||
      item["index"] !== index ||
      ["class", "id", "name", "type"].some(
        (key) => typeof item[key] !== "string",
      ) ||
      typeof item["enabled"] !== "boolean" ||
      typeof item["offscreen"] !== "boolean" ||
      ![null, true, false].includes(item["selected"] as null | boolean) ||
      ["width", "height"].some(
        (key) => !Number.isFinite(item[key]) || Number(item[key]) < 0,
      ) ||
      ["x", "y"].some(
        (key) =>
          !(item["offscreen"] && item[key] === null) &&
          !Number.isFinite(item[key]),
      )
    )
      throw new Error("Partial closed UI tree");
  }
  const selected = view.tree.filter((item) => item["selected"] === true);
  if (
    selected.length > 1 ||
    view.selectedEntry !== (selected[0]?.["name"] ?? null)
  )
    throw new Error("Ambiguous original selection");
}
/** Strict original output decoding only; this DTO never grants UI/SDK authority. */
export function readControlledHostUiCapture(
  raw: string,
  process: ControlledProcess,
  inputDelivered: boolean,
  hwnd?: string,
): Capture {
  const result = decodeAdmissionJson(raw) as Capture;
  if (
    !result ||
    Object.keys(result).sort().join() !== "inputDelivered,png,view" ||
    result.inputDelivered !== inputDelivered ||
    !result.view ||
    !isDeepStrictEqual(result.view.process, process) ||
    !/^[1-9][0-9]*$/.test(result.view.hwnd) ||
    (hwnd !== undefined && result.view.hwnd !== hwnd) ||
    !Array.isArray(result.view.tree) ||
    !result.view.main ||
    typeof result.png !== "string"
  )
    throw new Error("Partial/wrong original UI capture");
  const png = Buffer.from(result.png, "base64");
  if (png.toString("base64") !== result.png)
    throw new Error("Original screenshot missing/partial");
  validateView(result.view);
  validateImage(png, result.view);
  return result;
}
/** Explicit finite whitelist for the existing native private-file adapter. */
export function controlledHostUiAuditPaths(
  directory: string,
  intentPath: string,
): readonly string[] {
  const phases = [
    "prepare",
    "manager",
    "prepared",
    "open-manager",
    "select-entry",
    "start",
  ];
  const names = ["open-manager", "select-entry", "start"].flatMap((phase) => [
    `${phase}-attempt.json`,
    `${phase}-attempt.json.dispatch`,
    `${phase}-input.png`,
    `${phase}-delivered.json`,
  ]);
  for (let i = 0; i < 6; i++)
    for (const phase of phases)
      for (const ext of ["png", "json"])
        names.push(`${String(i).padStart(2, "0")}-${phase}.${ext}`);
  return Object.freeze([
    ...names.map((name) => path.win32.join(directory, name)),
    `${intentPath}.ui-start-attempt.json`,
    `${intentPath}.ui-start-attempt.json.dispatch`,
  ]);
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const samePath = (a: string, b: string) =>
  path.win32.normalize(a).toLowerCase() ===
  path.win32.normalize(b).toLowerCase();
const ref = (file: ControlledFile) => ({
  nativePath: file.nativePath,
  sha256: file.sha256,
  identity: file.identity,
});
function sync(fence: () => void) {
  const result: unknown = fence();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Synchronous held lease fence required");
  }
}
function mappedBytes(file: string, expected?: string): Buffer {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new Error("Regular non-aliased mapped original required");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stamp = (value: typeof before) =>
      [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
        ":",
      );
    const opened = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    if (
      stamp(before) !== stamp(opened) ||
      stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true })) ||
      stamp(opened) !== stamp(fs.lstatSync(file, { bigint: true })) ||
      (expected && digest(bytes) !== expected)
    )
      throw new Error("Mapped original path/FD bytes changed");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Private ROOT-only one-shot UI ports. Native adapter supplies full qualified
 * source/vendor/process checks and native private-DACL/original-file validation.
 * ROOT supplies the actual held lease. Neither UIA nor screenshots prove those
 * assumptions. Unknown input outcome permanently poisons this instance.
 */
export function createControlledHostUi(
  options: ControlledHostUiPins,
  native: ControlledNativeAdapter,
  lease: ControlledHostUiLease,
) {
  const pins = structuredClone(options);
  const encodedCommand = Buffer.from(
    controlledHostUiNative,
    "utf16le",
  ).toString("base64");
  if (pins.powershell.length + encodedCommand.length + 128 > 32766)
    throw new Error(
      "Qualified UI helper exceeds the Windows command-line budget",
    );
  const entry = path.win32.join(
    native.installedDirectory,
    "AutodeskFusionMCP.py",
  );
  for (const value of [pins.powershell, pins.executable, pins.auditDirectory]) {
    if (
      !/^[A-Za-z]:\\/.test(value) ||
      path.win32.normalize(value) !== value ||
      value.includes("\0")
    )
      throw new Error("Canonical pinned local native path required");
  }
  if (
    !/^[a-f0-9]{64}$/.test(pins.powershellSha256) ||
    !/^[a-f0-9]{64}$/.test(pins.powershellConfigSha256) ||
    !/^[a-f0-9]{64}$/.test(pins.executableSha256) ||
    !samePath(pins.installedEntry.name, entry) ||
    !pins.mainClass ||
    !path.isAbsolute(pins.mappedPowershell) ||
    !path.isAbsolute(pins.mappedAuditDirectory)
  )
    throw new Error("Qualified UI/source pins required");
  for (const selector of [pins.openManager, pins.installedEntry, pins.start]) {
    if (
      Object.keys(selector).sort().join() !== "class,id,name,type" ||
      Object.values(selector).some(
        (value) => typeof value !== "string" || value.includes("\0"),
      )
    )
      throw new Error("Closed exact UI selector required");
  }
  if (
    isDeepStrictEqual(pins.openManager, pins.start) ||
    isDeepStrictEqual(pins.installedEntry, pins.start) ||
    isDeepStrictEqual(pins.openManager, pins.installedEntry)
  )
    throw new Error("Reviewed prepare/select/start controls must be disjoint");
  const sourceRelative = path.win32.relative(
    native.installedDirectory,
    pins.auditDirectory,
  );
  if (
    sourceRelative !== ".." &&
    !sourceRelative.startsWith("..\\") &&
    !path.win32.isAbsolute(sourceRelative)
  )
    throw new Error("UI audit outputs must not enter installed source");
  let poisoned = false,
    prepared = false,
    started = false,
    busy = false,
    serial = 0;
  let originalProcess: ControlledProcess | undefined;
  let hwnd: string | undefined;
  const originals: ControlledFile[] = [];
  let mappedFence: (() => void) | undefined;
  let mappedCount = -1;
  const leaseFence = () => {
    if (poisoned) throw new Error("UI outcome revoked; no retry/replay");
    sync(() => lease.fence());
  };
  const synchronous = () => {
    leaseFence();
    mappedBytes(pins.mappedPowershell, pins.powershellSha256);
    mappedBytes(`${pins.mappedPowershell}.config`, pins.powershellConfigSha256);
    if (!mappedFence || mappedCount !== originals.length) {
      mappedFence?.();
      mappedFence = native.captureSynchronousFence(originals);
      mappedCount = originals.length;
    }
    sync(mappedFence);
    leaseFence();
  };
  async function fenced<T>(operation: () => Promise<T>): Promise<T> {
    leaseFence();
    const value = await operation();
    leaseFence();
    return value;
  }
  async function current(process: ControlledProcess) {
    synchronous();
    await fenced(() => lease.assertCurrent());
    await fenced(() => native.assertSource());
    await fenced(() => native.assertProcess(process));
    for (const file of originals)
      await fenced(() => native.assertOriginal(file));
    await fenced(() => lease.assertCurrent());
    synchronous();
  }
  async function publishAt(nativePath: string, bytes: Uint8Array) {
    const mapped = native.nativePathMappings[nativePath];
    if (!mapped || !path.isAbsolute(mapped))
      throw new Error("Explicit original native/mapped audit path required");
    synchronous();
    const fd = fs.openSync(
      mapped,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    synchronous();
    const original = await fenced(() => native.readOriginal(nativePath));
    if (
      original.sha256 !== digest(bytes) ||
      digest(original.bytes) !== original.sha256 ||
      !Buffer.from(original.bytes).equals(mappedBytes(mapped, original.sha256))
    )
      throw new Error("Original private audit bytes differ");
    const file = Object.freeze({
      ...original,
      bytes: Buffer.from(original.bytes),
    });
    originals.push(file);
    return file;
  }
  function publish(name: string, bytes: Uint8Array) {
    const nativePath = path.win32.join(pins.auditDirectory, name);
    if (
      native.nativePathMappings[nativePath] !==
      path.join(pins.mappedAuditDirectory, name)
    )
      throw new Error("Exact original audit directory mapping required");
    return publishAt(nativePath, bytes);
  }
  async function invoke(
    process: ControlledProcess,
    action: "capture" | "invoke" | "select",
    expected: View | null,
    selector?: ControlledUiSelector,
    attempt?: ControlledFile,
    intent?: ControlledFile,
    profile?: ControlledFile,
  ): Promise<Capture> {
    await current(process);
    const response = await fenced(
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            pins.mappedPowershell,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encodedCommand,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "",
            overflow = false;
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (text: string) => {
            if (stdout.length + text.length <= 32 * 1024 * 1024) stdout += text;
            else overflow = true;
          });
          child.stderr.on("data", (text: string) => {
            if (stderr.length + text.length <= 1024 * 1024) stderr += text;
            else overflow = true;
          });
          child.on("error", reject);
          child.stdin.on("error", () => {
            /* Never resend uncertain input. */
          });
          child.on("close", (code) => {
            if (code !== 0 || overflow)
              reject(
                new ControlledFusionNativeError(`ui-${action}`, stdout, stderr),
              );
            else resolve(stdout);
          });
          child.stdin.end(
            json({
              process,
              action,
              expected,
              selector: selector ?? null,
              entry,
              executable: pins.executable,
              executableSha256: pins.executableSha256,
              mainClass: pins.mainClass,
              powershell: pins.powershell,
              powershellSha256: pins.powershellSha256,
              powershellConfigSha256: pins.powershellConfigSha256,
              attempt: attempt ? ref(attempt) : null,
              intent: intent ? ref(intent) : null,
              profile: profile ? ref(profile) : null,
              dispatchPath: attempt ? `${attempt.nativePath}.dispatch` : null,
            }),
          );
        }),
    );
    await current(process);
    let result: Capture;
    try {
      result = readControlledHostUiCapture(
        response,
        process,
        action !== "capture",
        hwnd,
      );
    } catch (error) {
      throw new ControlledFusionNativeError(
        `ui-${action}-decode`,
        response,
        error instanceof Error ? error.message : "Partial native output",
      );
    }
    hwnd ??= result.view.hwnd;
    return result;
  }
  async function capture(process: ControlledProcess, phase: string) {
    const observed = await invoke(process, "capture", null);
    const prefix = `${String(serial++).padStart(2, "0")}-${phase}`;
    const image = await publish(
      `${prefix}.png`,
      Buffer.from(observed.png, "base64"),
    );
    const tree = await publish(
      `${prefix}.json`,
      json({
        kind: "controlled-host-ui-observation-v1",
        authority: "NONE",
        view: observed.view,
        image: ref(image),
      }),
    );
    return { ...observed, reference: tree };
  }
  function control(view: View, selector: ControlledUiSelector) {
    const found = view.tree.filter(
      (item) =>
        item["id"] === selector.id &&
        item["name"] === selector.name &&
        item["class"] === selector.class &&
        item["type"] === selector.type,
    );
    if (
      found.length !== 1 ||
      found[0]!["offscreen"] !== false ||
      found[0]!["enabled"] !== true ||
      !(Number(found[0]!["width"]) > 0) ||
      !(Number(found[0]!["height"]) > 0)
    )
      throw new Error("Unambiguous visible exact control required");
  }
  async function input(
    process: ControlledProcess,
    phase: string,
    action: "invoke" | "select",
    selector: ControlledUiSelector,
    requireSelection: boolean,
    intent?: ControlledFile,
    profile?: ControlledFile,
  ) {
    const before = await capture(process, phase);
    control(before.view, selector);
    if (requireSelection && before.view.selectedEntry !== entry)
      throw new Error("Fresh exact installed selection required");
    if (intent) await fenced(() => native.assertOriginal(intent));
    await current(process);
    // This exclusive, fsynced, native DACL-checked original survives ambiguous
    // delivery. A new adapter with the same paths cannot replay the input.
    const attemptPath = intent
      ? `${intent.nativePath}.ui-start-attempt.json`
      : path.win32.join(pins.auditDirectory, `${phase}-attempt.json`);
    if (!native.nativePathMappings[`${attemptPath}.dispatch`])
      throw new Error("Pinned durable native dispatch path required");
    const attempt = await publishAt(
      attemptPath,
      json({
        kind: "controlled-host-ui-input-attempt-v1",
        authority: "NONE",
        process,
        action,
        selector,
        observation: ref(before.reference),
        intent: intent ? ref(intent) : null,
      }),
    );
    const delivered = await invoke(
      process,
      action,
      before.view,
      selector,
      attempt,
      intent,
      profile,
    );
    if (!isDeepStrictEqual(delivered.view, before.view))
      throw new Error("Input original view changed");
    const image = await publish(
      `${phase}-input.png`,
      Buffer.from(delivered.png, "base64"),
    );
    const dispatch = await fenced(() =>
      native.readOriginal(`${attemptPath}.dispatch`),
    );
    originals.push(
      Object.freeze({ ...dispatch, bytes: Buffer.from(dispatch.bytes) }),
    );
    const receipt = await publish(
      `${phase}-delivered.json`,
      json({
        kind: "controlled-host-ui-input-observation-v1",
        authority: "NONE",
        process,
        selectedEntry: delivered.view.selectedEntry,
        observation: ref(before.reference),
        attempt: ref(attempt),
        dispatch: ref(dispatch),
        image: ref(image),
        inputDelivered: true,
        startupProven: false,
      }),
    );
    return {
      process: Object.freeze({ ...process }),
      selectedEntry: entry,
      reference: receipt,
    };
  }
  async function once<T>(operation: () => Promise<T>): Promise<T> {
    if (poisoned || busy) {
      poisoned = true;
      throw new Error("Unknown/concurrent UI outcome; no retry/replay");
    }
    busy = true;
    try {
      return await operation();
    } catch (error) {
      poisoned = true;
      throw error;
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    prepareExactHost: (request: {
      process: ControlledProcess;
      entry: string;
    }) =>
      once(async () => {
        if (prepared || !samePath(request.entry, entry))
          throw new Error("Exact UI preparation cannot be replayed");
        prepared = true;
        originalProcess = Object.freeze({ ...request.process });
        const first = await capture(originalProcess, "prepare");
        const entries = first.view.tree.filter(
          (item) =>
            item["name"] === entry &&
            item["offscreen"] === false &&
            item["enabled"] === true,
        );
        if (entries.length === 0)
          await input(
            originalProcess,
            "open-manager",
            "invoke",
            pins.openManager,
            false,
          );
        const manager = await capture(originalProcess, "manager");
        control(manager.view, pins.installedEntry);
        if (manager.view.selectedEntry !== entry)
          await input(
            originalProcess,
            "select-entry",
            "select",
            pins.installedEntry,
            false,
          );
        const final = await capture(originalProcess, "prepared");
        if (final.view.selectedEntry !== entry)
          throw new Error("Exact installed entry not selected");
        control(final.view, pins.start);
        return {
          process: originalProcess,
          selectedEntry: entry,
          reference: final.reference,
        };
      }),
    startReviewedFork: (request: {
      process: ControlledProcess;
      entry: string;
      intent: ControlledFile;
    }) =>
      once(async () => {
        if (
          !prepared ||
          started ||
          !isDeepStrictEqual(request.process, originalProcess) ||
          !samePath(request.entry, entry)
        )
          throw new Error(
            "Original prepared process/entry required; no start replay",
          );
        started = true;
        const intent = Object.freeze({
          ...request.intent,
          bytes: Buffer.from(request.intent.bytes),
        });
        if (
          intent.nativePath !== native.paths.intent ||
          digest(intent.bytes) !== intent.sha256
        )
          throw new Error("Original intent path/bytes required");
        await fenced(() => native.assertOriginal(intent));
        const value = decodeAdmissionJson(
          Buffer.from(intent.bytes).toString("utf8"),
        ) as BootstrapEntryIntent;
        if (
          !value ||
          Object.keys(value).sort().join() !==
            "engineVersion,installed,kind,nonce,process,profile,purpose,receipts,version" ||
          value.kind !== "fmcad-bootstrap-entry-intent" ||
          value.version !== 1 ||
          value.purpose !== "isolated-stdout-v1" ||
          value.engineVersion !== 2 ||
          !/^[a-f0-9]{32}$/.test(value.nonce) ||
          !isDeepStrictEqual(value.process, originalProcess) ||
          value.installed?.directory !== native.installedDirectory ||
          value.installed.source !== native.installedSource ||
          !isDeepStrictEqual(value.installed.files, native.installedFiles) ||
          value.profile?.path !== native.paths.profile ||
          !isDeepStrictEqual(value.receipts, {
            directory: native.paths.receiptDirectory,
            entry: path.win32.basename(native.paths.entry),
            returned: path.win32.basename(native.paths.returned),
          })
        )
          throw new Error("Original intent process/source closure differs");
        const profile = await fenced(() =>
          native.readOriginal(native.paths.profile),
        );
        if (
          value.profile.sha256 !== profile.sha256 ||
          !matchesControlledFusionAutoload(profile.bytes, entry)
        )
          throw new Error("Original post-prepare ALL-OFF profile differs");
        originals.push(
          Object.freeze({ ...profile, bytes: Buffer.from(profile.bytes) }),
        );
        originals.push(intent);
        return input(
          originalProcess!,
          "start",
          "invoke",
          pins.start,
          true,
          intent,
          profile,
        );
      }),
  });
}
