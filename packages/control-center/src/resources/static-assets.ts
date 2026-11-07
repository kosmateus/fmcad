import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConsoleHttpAsset } from "../server/protocol.js";

export const CONTROL_CENTER_ASSET_ROOT = "assets/control-center";
const MANIFEST_FILE = "asset-manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;
const KNOWN_MODULES = [
  "agents-projects.js",
  "api.js",
  "app.js",
  "index.js",
  "locale-catalogs.js",
  "locale-runtime.js",
  "locale-selector.js",
  "locale-system-controls.js",
  "locale-system-view.js",
  "locale-web-ui.js",
  "read-model.js",
  "select-controls.js",
  "table-model.js",
] as const;
const KNOWN_FONTS = [
  "dm-sans-latin-ext.woff2",
  "dm-sans-latin.woff2",
  "ibm-plex-mono-latin-ext-medium.woff2",
  "ibm-plex-mono-latin-ext.woff2",
  "ibm-plex-mono-latin-medium.woff2",
  "ibm-plex-mono-latin.woff2",
] as const;
const KNOWN_ASSETS = new Map<string, { file: string; contentType: string }>([
  [
    "/index.html",
    { file: "index.html", contentType: "text/html; charset=utf-8" },
  ],
  [
    "/assets/control-center/contracts/project-actions.js",
    {
      file: "contracts/project-actions.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/assets/control-center/contracts/query.js",
    {
      file: "contracts/query.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  ...KNOWN_MODULES.map(
    (name) =>
      [
        `/assets/control-center/web/${name}`,
        { file: `web/${name}`, contentType: "text/javascript; charset=utf-8" },
      ] as const,
  ),
  [
    "/assets/control-center/assets/styles.css",
    { file: "assets/styles.css", contentType: "text/css; charset=utf-8" },
  ],
  [
    "/assets/control-center/assets/locale-selector.css",
    {
      file: "assets/locale-selector.css",
      contentType: "text/css; charset=utf-8",
    },
  ],
  [
    "/assets/control-center/assets/favicon.svg",
    { file: "assets/favicon.svg", contentType: "image/svg+xml" },
  ],
  [
    "/assets/control-center/assets/vendor/highlight.min.js",
    {
      file: "assets/vendor/highlight.min.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  ...KNOWN_FONTS.map(
    (name) =>
      [
        `/assets/control-center/assets/fonts/${name}`,
        { file: `assets/fonts/${name}`, contentType: "font/woff2" },
      ] as const,
  ),
]);
const KNOWN_NOTICES = [
  "ASSET-NOTICES.md",
  "assets/fonts/DM-Sans-OFL.txt",
  "assets/fonts/IBM-Plex-Mono-OFL.txt",
  "assets/vendor/highlight-LICENSE.txt",
] as const;

interface AssetRecord {
  readonly path: string;
  readonly file: string;
  readonly contentType: ConsoleHttpAsset["contentType"];
  readonly bytes: number;
  readonly sha256: string;
}

interface NoticeRecord {
  readonly file: string;
  readonly sha256: string;
}

export interface ControlCenterAssetManifest {
  readonly version: 1;
  readonly entrypoint: string;
  readonly assets: readonly AssetRecord[];
  readonly notices: readonly NoticeRecord[];
  readonly fingerprint: string;
}

const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_CONSOLE_ASSETS" });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid("Console asset manifest record is invalid");
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function safeRelativeFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(part),
      )
  );
}

function publicRoute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "/index.html" ||
      /^\/assets\/control-center\/(?:web|contracts|assets)\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:js|css|svg|woff2|png|ico)$/.test(
        value,
      ))
  );
}

function contentType(file: string): ConsoleHttpAsset["contentType"] | null {
  if (file === "index.html") return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return null;
}

function checkedDirectory(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    return invalid("Console asset root must be a real directory");
  return realpathSync(path);
}

function readContainedFile(root: string, relativeFile: string): Buffer {
  if (!safeRelativeFile(relativeFile))
    return invalid("Console asset manifest contains an unsafe file path");
  let current = root;
  const parts = relativeFile.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      return invalid("Console asset files cannot be symlinks");
    if (index < parts.length - 1 && !stat.isDirectory())
      return invalid("Console asset path is not a directory");
    if (index === parts.length - 1 && !stat.isFile())
      return invalid("Console asset path is not a regular file");
    if (index === parts.length - 1 && stat.size > MAX_ASSET_BYTES)
      return invalid("Console asset file exceeds the size limit");
  }
  const resolved = realpathSync(current);
  const escaped = relative(root, resolved);
  if (
    !escaped ||
    escaped === ".." ||
    escaped.startsWith(`..${sep}`) ||
    resolve(root, escaped) !== resolved
  )
    return invalid("Console asset path escapes its installed root");
  return readFileSync(resolved);
}

function parseAsset(value: unknown): AssetRecord {
  const input = record(value);
  if (!exactKeys(input, ["path", "file", "contentType", "bytes", "sha256"]))
    return invalid(
      "Console asset manifest contains an unsupported asset record",
    );
  const route = input["path"];
  const file = input["file"];
  const type = input["contentType"];
  const bytes = input["bytes"];
  const sha256 = input["sha256"];
  const known = typeof route === "string" ? KNOWN_ASSETS.get(route) : undefined;
  if (
    !publicRoute(route) ||
    !known ||
    !safeRelativeFile(file) ||
    file !== known.file ||
    type !== known.contentType ||
    type !== contentType(file) ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) < 0 ||
    Number(bytes) > MAX_ASSET_BYTES ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    return invalid(
      "Console asset manifest contains an invalid route or resource",
    );
  return {
    path: route,
    file,
    contentType: type as ConsoleHttpAsset["contentType"],
    bytes: Number(bytes),
    sha256,
  };
}

function parseNotice(value: unknown): NoticeRecord {
  const input = record(value);
  if (
    !exactKeys(input, ["file", "sha256"]) ||
    !safeRelativeFile(input["file"]) ||
    typeof input["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(input["sha256"])
  )
    return invalid("Console asset notice inventory is invalid");
  return { file: input["file"], sha256: input["sha256"] };
}

function readManifest(installationRoot: string): {
  root: string;
  manifest: ControlCenterAssetManifest;
} {
  if (!isAbsolute(installationRoot))
    return invalid("Console installation root must be absolute");
  const installStat = lstatSync(installationRoot);
  if (!installStat.isDirectory() || installStat.isSymbolicLink())
    return invalid("Console installation root must be a real directory");
  const installRoot = realpathSync(installationRoot);
  const root = checkedDirectory(
    join(checkedDirectory(join(installRoot, "assets")), "control-center"),
  );
  const manifestBytes = readContainedFile(root, MANIFEST_FILE);
  if (manifestBytes.length > MAX_MANIFEST_BYTES)
    return invalid("Console asset manifest exceeds the size limit");
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  } catch (error) {
    return invalid(`Console asset manifest JSON is invalid: ${String(error)}`);
  }
  if (
    !exactKeys(parsed, [
      "version",
      "entrypoint",
      "assets",
      "notices",
      "fingerprint",
    ]) ||
    parsed["version"] !== 1 ||
    !publicRoute(parsed["entrypoint"]) ||
    !Array.isArray(parsed["assets"]) ||
    parsed["assets"].length < 1 ||
    parsed["assets"].length > 512 ||
    !Array.isArray(parsed["notices"]) ||
    parsed["notices"].length > 32 ||
    typeof parsed["fingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed["fingerprint"])
  )
    return invalid("Console asset manifest header is invalid");

  const assets = parsed["assets"].map(parseAsset);
  const notices = parsed["notices"].map(parseNotice);
  const routes = new Set<string>();
  let totalBytes = 0;
  for (const asset of assets) {
    if (routes.has(asset.path))
      return invalid("Console asset routes must be unique");
    routes.add(asset.path);
    totalBytes += asset.bytes;
  }
  if (
    parsed["entrypoint"] !== "/assets/control-center/web/index.js" ||
    routes.size !== KNOWN_ASSETS.size ||
    [...KNOWN_ASSETS.keys()].some((route) => !routes.has(route)) ||
    totalBytes > MAX_TOTAL_ASSET_BYTES
  )
    return invalid("Console browser entrypoint or total asset size is invalid");
  if (
    notices.length !== KNOWN_NOTICES.length ||
    new Set(notices.map((notice) => notice.file)).size !==
      KNOWN_NOTICES.length ||
    KNOWN_NOTICES.some(
      (file) => !notices.some((notice) => notice.file === file),
    )
  )
    return invalid("Console asset notice inventory is incomplete");
  const payload = {
    version: 1 as const,
    entrypoint: parsed["entrypoint"],
    assets,
    notices,
  };
  if (digest(JSON.stringify(payload)) !== parsed["fingerprint"])
    return invalid("Console asset manifest fingerprint does not match");
  return {
    root,
    manifest: {
      ...payload,
      fingerprint: parsed["fingerprint"],
    },
  };
}

function verifiedBytes(
  root: string,
  file: string,
  bytes: number,
  sha256: string,
): Buffer {
  const value = readContainedFile(root, file);
  if (value.length !== bytes || digest(value) !== sha256)
    return invalid("Installed console asset bytes do not match the manifest");
  return value;
}

/** Read the installed, build-hashable manifest without resolving source paths. */
export function readControlCenterAssetManifest(
  installationRoot: string,
): ControlCenterAssetManifest {
  const { root, manifest } = readManifest(installationRoot);
  for (const asset of manifest.assets)
    verifiedBytes(root, asset.file, asset.bytes, asset.sha256);
  for (const notice of manifest.notices)
    if (digest(readContainedFile(root, notice.file)) !== notice.sha256)
      invalid("Installed console asset notice does not match the manifest");
  return manifest;
}

/** Return the verified allowlisted files in the shape accepted by HTTP service. */
export function loadConsoleHttpAssets(
  installationRoot: string,
): readonly ConsoleHttpAsset[] {
  const { root, manifest } = readManifest(installationRoot);
  for (const notice of manifest.notices)
    if (digest(readContainedFile(root, notice.file)) !== notice.sha256)
      invalid("Installed console asset notice does not match the manifest");
  return Object.freeze(
    manifest.assets.map((asset) =>
      Object.freeze({
        path: asset.path,
        contentType: asset.contentType,
        body: verifiedBytes(root, asset.file, asset.bytes, asset.sha256),
      }),
    ),
  );
}
