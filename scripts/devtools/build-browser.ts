// Independent browser build. The root packager must run this before writing
// dist/runtime-build.json so these local ESM/assets enter its fingerprint.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import type { ControlCenterAssetManifest } from "../../packages/control-center/dist/resources/static-assets.js";
type AssetRecord = ControlCenterAssetManifest["assets"][number];

export function buildBrowserAssets(
  repository: string,
): ControlCenterAssetManifest {
  const workspace = path.join(repository, "packages/control-center");
  const sourceWeb = path.join(workspace, "src/web");
  const sourceAssets = path.join(workspace, "src/web/assets");
  const moduleOutput = path.join(workspace, "dist/browser");
  const defaultOutputRoot = path.join(repository, "dist/assets/control-center");
  const entrypoint = "/assets/control-center/web/index.js";
  const fonts = [
    "DM-Sans-OFL.txt",
    "IBM-Plex-Mono-OFL.txt",
    "dm-sans-latin-ext.woff2",
    "dm-sans-latin.woff2",
    "ibm-plex-mono-latin-ext-medium.woff2",
    "ibm-plex-mono-latin-ext.woff2",
    "ibm-plex-mono-latin-medium.woff2",
    "ibm-plex-mono-latin.woff2",
  ];
  const notices = [
    "ASSET-NOTICES.md",
    "assets/fonts/DM-Sans-OFL.txt",
    "assets/fonts/IBM-Plex-Mono-OFL.txt",
    "assets/vendor/highlight-LICENSE.txt",
  ];
  const mimeTypes: Readonly<Record<string, AssetRecord["contentType"]>> = {
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  const hash = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

  function copyFile(source: string, destination: string): Buffer {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        `Browser asset is not a regular file: ${path.basename(source)}`,
      );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return fs.readFileSync(destination);
  }

  function walkCompiled(directory: string, outputRoot: string): string[] {
    const files: string[] = [];
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const source = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Browser output cannot contain symlinks");
      if (entry.isDirectory()) files.push(...walkCompiled(source, outputRoot));
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const relative = path
          .relative(outputRoot, source)
          .split(path.sep)
          .join("/");
        files.push(relative);
      } else {
        throw new Error(`Unexpected browser compiler output: ${entry.name}`);
      }
    }
    return files;
  }

  function copyAndDescribe(
    outputRoot: string,
    sourceRelative: string,
    outputRelative: string,
    route: string,
  ): AssetRecord {
    const bytes = copyFile(
      path.join(sourceAssets, sourceRelative),
      path.join(outputRoot, outputRelative),
    );
    const extension = path.extname(outputRelative).toLowerCase();
    const contentType = mimeType(extension);
    return {
      path: route,
      file: outputRelative.split(path.sep).join("/"),
      contentType,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
  }

  function mimeType(extension: string): AssetRecord["contentType"] {
    const contentType = mimeTypes[extension];
    if (!contentType)
      throw new Error(`Unsupported browser asset extension: ${extension}`);
    return contentType;
  }

  const outputRoot = defaultOutputRoot;
  const tsc = require.resolve("typescript/bin/tsc", { paths: [repository] });
  const workspaceOutput = fs.existsSync(moduleOutput)
    ? fs.lstatSync(moduleOutput)
    : null;
  if (workspaceOutput?.isSymbolicLink())
    throw new Error("Browser compiler output cannot be a symlink");
  if (workspaceOutput)
    fs.rmSync(moduleOutput, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      tsc,
      "--project",
      path.join(workspace, "tsconfig.browser.json"),
      "--pretty",
      "false",
    ],
    {
      cwd: repository,
      stdio: "inherit",
    },
  );

  const outputParent = path.dirname(outputRoot);
  const distRoot = path.join(repository, "dist");
  fs.mkdirSync(distRoot, { recursive: true });
  const distStat = fs.lstatSync(distRoot);
  if (!distStat.isDirectory() || distStat.isSymbolicLink())
    throw new Error("Browser runtime output root must be a real directory");
  fs.mkdirSync(outputParent, { recursive: true });
  const parentStat = fs.lstatSync(outputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error("Browser asset parent must be a real directory");
  const existing = fs.existsSync(outputRoot) ? fs.lstatSync(outputRoot) : null;
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error("Browser asset output must be an owned real directory");
  if (existing) fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const sourceIndex = fs.readFileSync(
    path.join(sourceAssets, "index.html"),
    "utf8",
  );
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [
      'href="./favicon.svg"',
      'href="/assets/control-center/assets/favicon.svg"',
    ],
    ['href="./styles.css"', 'href="/assets/control-center/assets/styles.css"'],
    [
      'src="./vendor/highlight.min.js"',
      'src="/assets/control-center/assets/vendor/highlight.min.js"',
    ],
    ['src="/assets/index.js"', `src="${entrypoint}"`],
  ];
  let html = sourceIndex;
  for (const [from, to] of replacements) {
    if (html.split(from).length !== 2)
      throw new Error(
        `Browser entry HTML changed its expected local asset link: ${from}`,
      );
    html = html.replace(from, to);
  }
  const htmlBytes = Buffer.from(html, "utf8");
  fs.writeFileSync(path.join(outputRoot, "index.html"), htmlBytes, {
    flag: "wx",
  });
  const assets: AssetRecord[] = [
    {
      path: "/index.html",
      file: "index.html",
      contentType: mimeType(".html"),
      bytes: htmlBytes.length,
      sha256: hash(htmlBytes),
    },
  ];

  const moduleFiles = [
    ...walkCompiled(path.join(moduleOutput, "web"), moduleOutput),
    ...walkCompiled(path.join(moduleOutput, "contracts"), moduleOutput),
  ].sort();
  if (
    !moduleFiles.includes("web/index.js") ||
    !moduleFiles.includes("contracts/query.js")
  )
    throw new Error(
      "Browser ESM entrypoint or shared query contract was not emitted",
    );
  for (const relative of moduleFiles) {
    const destination = path.join(outputRoot, relative);
    const bytes = copyFile(path.join(moduleOutput, relative), destination);
    assets.push({
      path: `/assets/control-center/${relative}`,
      file: relative,
      contentType: mimeType(".js"),
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  }

  assets.push(
    copyAndDescribe(
      outputRoot,
      "styles.css",
      "assets/styles.css",
      "/assets/control-center/assets/styles.css",
    ),
  );
  assets.push(
    copyAndDescribe(
      outputRoot,
      "favicon.svg",
      "assets/favicon.svg",
      "/assets/control-center/assets/favicon.svg",
    ),
  );
  assets.push(
    copyAndDescribe(
      outputRoot,
      "locale-selector.css",
      "assets/locale-selector.css",
      "/assets/control-center/assets/locale-selector.css",
    ),
  );
  const highlightBytes = copyFile(
    path.join(sourceWeb, "vendor/highlight.min.js"),
    path.join(outputRoot, "assets/vendor/highlight.min.js"),
  );
  assets.push({
    path: "/assets/control-center/assets/vendor/highlight.min.js",
    file: "assets/vendor/highlight.min.js",
    contentType: mimeType(".js"),
    bytes: highlightBytes.length,
    sha256: hash(highlightBytes),
  });
  for (const filename of fonts) {
    if (filename.endsWith(".txt")) {
      copyFile(
        path.join(sourceAssets, "fonts", filename),
        path.join(outputRoot, "assets/fonts", filename),
      );
      continue;
    }
    assets.push(
      copyAndDescribe(
        outputRoot,
        path.join("fonts", filename),
        path.join("assets/fonts", filename),
        `/assets/control-center/assets/fonts/${filename}`,
      ),
    );
  }
  for (const filename of notices) {
    if (filename === "ASSET-NOTICES.md")
      copyFile(
        path.join(sourceAssets, filename),
        path.join(outputRoot, filename),
      );
    else if (filename === "assets/vendor/highlight-LICENSE.txt")
      copyFile(
        path.join(sourceWeb, "vendor/highlight-LICENSE.txt"),
        path.join(outputRoot, filename),
      );
  }

  assets.sort((a, b) => a.path.localeCompare(b.path));
  const noticeRecords = notices.map((file) => ({
    file,
    sha256: hash(fs.readFileSync(path.join(outputRoot, file))),
  }));
  const payload = {
    version: 1 as const,
    entrypoint,
    assets,
    notices: noticeRecords,
  };
  const manifest = {
    ...payload,
    fingerprint: hash(Buffer.from(JSON.stringify(payload), "utf8")),
  };
  fs.writeFileSync(
    path.join(outputRoot, "asset-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return manifest;
}
