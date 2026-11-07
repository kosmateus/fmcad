import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const repository = "AutodeskFusion360/FusionAPIReference";
export const prefix = "Fusion_API_Python_Reference/defs/adsk/";
export const modules = [
  "__init__.py",
  "cam.py",
  "core.py",
  "drawing.py",
  "electron.py",
  "fusion.py",
  "sim.py",
  "volume.py",
] as const;
export const generator = "fmcad-annotated-copy-v1";
export const overlay = "point3d-nullable-v1";
export const authorization =
  "user-authorized-2026-10-24; Autodesk rights unverified; not legal clearance";
const licenseHash =
  "e9ca54e95f2f1d0782c1b2d54d4b3fad8fec890c05b3549f0a74452246d34f34";
const licenseSection =
  "This repository is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported (CC BY-NC-SA 3.0). See the `LICENSE` file for the full text.";
export const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");
export interface Policy {
  licenseHash: string;
  licenseSection: string;
}
export const policy: Policy = { licenseHash, licenseSection };
export interface Source {
  get(url: string, limit: number): Promise<Buffer>;
}
export interface ApiLock {
  readonly commit: string;
  readonly snapshot: string;
}
const maxFile = 8 * 1024 * 1024;
const maxTotal = 24 * 1024 * 1024;
export const network: Source = {
  async get(url, limit) {
    const token = process.env["GITHUB_TOKEN"];
    const authenticated =
      new URL(url).origin === "https://api.github.com" && Boolean(token);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      headers: {
        "User-Agent": "fmcad-adsk-refresh",
        Accept: "application/vnd.github+json",
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok || !response.body)
      throw new Error(`Download failed: ${response.status} ${url}`);
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > limit) {
        await response.body.cancel().catch(() => undefined);
        throw new Error("Download size limit exceeded");
      }
      parts.push(part);
    }
    const declared = response.headers.get("content-length");
    if (
      !response.headers.get("content-encoding") &&
      declared !== null &&
      Number(declared) !== size
    )
      throw new Error("Truncated download");
    return Buffer.concat(parts);
  },
};
interface Entry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function json(bytes: Buffer): Record<string, unknown> {
  return object(JSON.parse(bytes.toString("utf8")) as unknown);
}
function text(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function gitHash(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function safePath(name: string): boolean {
  return (
    !name.includes("\\") &&
    !name.includes("\0") &&
    !path.posix.isAbsolute(name) &&
    name.split("/").every((p) => p !== ".." && p !== "." && p !== "")
  );
}
export interface Manifest {
  schema: 1;
  repository: string;
  commit: string;
  apiRelease: string;
  generator: string;
  overlay: string;
  checker: string;
  authorization: string;
  license: Policy;
  source: Record<string, { sha256: string; gitBlob: string; bytes: number }>;
  files: Record<string, string>;
  limitations: string[];
}
function applyOverlay(source: string): string {
  const start = source.indexOf("class Point3D(Base):");
  const end = source.indexOf("\nclass ", start + 1);
  if (start < 0) throw new Error("Overlay conflict: missing Point3D");
  const section = source.slice(start, end < 0 ? undefined : end);
  const signature =
    "def create(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> Point3D:";
  if (
    section.split(signature).length !== 2 ||
    !section.includes(
      "Returns the new Point3D object or null if the creation failed.",
    )
  )
    throw new Error("Overlay conflict: review Point3D.create");
  return (
    source.slice(0, start) +
    section.replace(
      signature,
      signature.replace("-> Point3D:", "-> Point3D | None:"),
    ) +
    (end < 0 ? "" : source.slice(end))
  );
}
async function regular(file: string): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFile)
    throw new Error(`Invalid cache file: ${file}`);
  return fs.readFile(file);
}
async function directory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Invalid resource directory: ${dir}`);
}
export async function verifyCache(
  root: string,
  expected: Policy = policy,
): Promise<{ directory: string; manifest: Manifest }> {
  await directory(root);
  await directory(path.join(root, "snapshots"));
  const current = json(await regular(path.join(root, "current.json")));
  if (
    typeof current["snapshot"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(current["snapshot"])
  )
    throw new Error("Invalid cache pointer");
  const dir = path.join(root, "snapshots", current["snapshot"]);
  await directory(dir);
  const raw = await regular(path.join(dir, "manifest.json"));
  if (sha256(raw) !== current["snapshot"])
    throw new Error("Cache manifest hash mismatch");
  const value = json(raw);
  if (
    value["schema"] !== 1 ||
    value["repository"] !== repository ||
    value["generator"] !== generator ||
    value["overlay"] !== overlay ||
    value["authorization"] !== authorization ||
    value["checker"] !== "annotated-python; checker supplied separately" ||
    typeof value["commit"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(value["commit"]) ||
    JSON.stringify(value["license"]) !== JSON.stringify(expected)
  )
    throw new Error("Cache policy/generator mismatch");
  const files = object(value["files"]);
  const names = [
    ...modules.map((n) => `adsk/${n}`),
    "LICENSE.upstream",
    "README.upstream.md",
    "NOTICES.md",
  ].sort();
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(names))
    throw new Error("Invalid cache allowlist");
  await directory(path.join(dir, "adsk"));
  if (
    JSON.stringify((await fs.readdir(path.join(dir, "adsk"))).sort()) !==
      JSON.stringify([...modules].sort()) ||
    JSON.stringify((await fs.readdir(dir)).sort()) !==
      JSON.stringify(
        [
          "adsk",
          "LICENSE.upstream",
          "README.upstream.md",
          "NOTICES.md",
          "manifest.json",
        ].sort(),
      )
  )
    throw new Error("Unexpected cache files");
  for (const name of names)
    if (sha256(await regular(path.join(dir, name))) !== files[name])
      throw new Error(`Cache hash mismatch: ${name}`);
  if (files["LICENSE.upstream"] !== expected.licenseHash)
    throw new Error("Cached license does not match policy");
  return { directory: dir, manifest: value as unknown as Manifest };
}
export async function refresh(
  root: string,
  source: Source = network,
  expected: Policy = policy,
  lock?: ApiLock,
): Promise<Manifest> {
  const api = `https://api.github.com/repos/${repository}`;
  if (
    lock &&
    (!/^[a-f0-9]{40}$/.test(lock.commit) ||
      !/^[a-f0-9]{64}$/.test(lock.snapshot))
  )
    throw new Error("Invalid pinned API lock");
  let head: unknown = lock?.commit;
  if (!lock) {
    const metadata = json(await source.get(api, 1024 * 1024));
    const branch = metadata["default_branch"];
    if (typeof branch !== "string" || !branch || branch.length > 200)
      throw new Error("Missing default branch");
    head = json(
      await source.get(
        `${api}/commits/${encodeURIComponent(branch)}`,
        1024 * 1024,
      ),
    )["sha"];
  }
  if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head))
    throw new Error("Invalid immutable commit");
  const tree = json(
    await source.get(`${api}/git/trees/${head}?recursive=1`, 16 * 1024 * 1024),
  );
  if (tree["truncated"] !== false || !Array.isArray(tree["tree"]))
    throw new Error("Incomplete tree");
  const entries = new Map<string, Entry>();
  for (const raw of tree["tree"]) {
    const e = object(raw);
    if (typeof e["path"] !== "string" || !safePath(e["path"]))
      throw new Error("Unsafe tree path");
    const name = e["path"];
    if (entries.has(name)) throw new Error("Duplicate tree path");
    entries.set(name, e as unknown as Entry);
    if (
      (name.startsWith("Fusion_API_Python_Reference/") &&
        /(?:license|notice|copying)/i.test(path.posix.basename(name))) ||
      (!name.includes("/") &&
        /(?:license|notice|copying)/i.test(name) &&
        name !== "LICENSE") ||
      (name.startsWith(prefix) && !modules.some((n) => prefix + n === name)) ||
      ([
        "Fusion_API_Python_Reference",
        "Fusion_API_Python_Reference/defs",
        prefix.slice(0, -1),
      ].includes(name) &&
        (e["type"] !== "tree" || e["mode"] !== "040000"))
    )
      throw new Error(`Unreviewed upstream file/notice: ${name}`);
  }
  const wanted = ["LICENSE", "README.md", ...modules.map((n) => prefix + n)];
  const data = new Map<string, Buffer>();
  const hashes: Manifest["source"] = {};
  let total = 0;
  for (const name of wanted) {
    const e = entries.get(name);
    if (
      !e ||
      e.type !== "blob" ||
      e.mode !== "100644" ||
      !/^[a-f0-9]{40}$/.test(e.sha) ||
      !Number.isSafeInteger(e.size) ||
      e.size === undefined ||
      e.size < 0 ||
      e.size > maxFile
    )
      throw new Error(`Invalid allowlisted blob: ${name}`);
    total += e.size;
    if (total > maxTotal) throw new Error("Snapshot size limit exceeded");
  }
  for (const name of wanted) {
    const e = entries.get(name)!;
    const bytes = await source.get(
      `https://raw.githubusercontent.com/${repository}/${head}/${name}`,
      maxFile,
    );
    if (bytes.length !== e.size || gitHash(bytes) !== e.sha)
      throw new Error(`Blob integrity mismatch: ${name}`);
    text(bytes);
    data.set(name, bytes);
    hashes[name] = {
      sha256: sha256(bytes),
      gitBlob: e.sha,
      bytes: bytes.length,
    };
  }
  const get = (name: string): Buffer => {
    const value = data.get(name);
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const readme = text(get("README.md"));
  const terms = readme
    .split(/\nLicense\r?\n-+\r?\n/)[1]
    ?.split(/\r?\nAcknowledgements/)[0]
    ?.trim();
  if (
    sha256(get("LICENSE")) !== expected.licenseHash ||
    terms !== expected.licenseSection
  )
    throw new Error(
      "Upstream license changed: explicit user review required (not legal clearance)",
    );
  const release = /Updated as of (Fusion [^*\r\n]+ Release)/.exec(readme)?.[1];
  if (!release) throw new Error("Missing API release label");
  const outputs: Record<string, Buffer> = {};
  for (const name of modules)
    outputs[`adsk/${name}`] =
      name === "core.py"
        ? Buffer.from(applyOverlay(text(get(prefix + name))))
        : get(prefix + name);
  outputs["LICENSE.upstream"] = get("LICENSE");
  outputs["README.upstream.md"] = get("README.md");
  outputs["NOTICES.md"] = Buffer.from(
    `# Autodesk Fusion API definitions\n\nSource: https://github.com/${repository}/tree/${head}\nAPI label: ${release} (not installed-version compatibility).\n\nOfficial Autodesk-origin annotated editor definitions; not SDK implementations.\nRetained upstream LICENSE and README govern third-party material; fmcad's MIT license does not relicense it. Observed terms include CC BY-NC-SA 3.0 and appended Patrick Rainsberry MIT text of unresolved scope.\n\nDistribution decision: ${authorization}.\nNo Autodesk grant or legal clearance is asserted.\n\nModification: Point3D.create return annotated nullable per its upstream documentation; no other API invented. sim.py has no API declarations and is not complete simulation coverage. Never import these files for SDK execution.\n`,
  );
  const manifest: Manifest = {
    schema: 1,
    repository,
    commit: head,
    apiRelease: release,
    generator,
    overlay,
    checker: "annotated-python; checker supplied separately",
    authorization,
    license: expected,
    source: hashes,
    files: Object.fromEntries(
      Object.entries(outputs)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([n, b]) => [n, sha256(b)]),
    ),
    limitations: [
      "sim.py contains no declarations",
      "API release label is not installed Fusion compatibility",
    ],
  };
  const serialized = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const id = sha256(serialized);
  if (lock && id !== lock.snapshot)
    throw new Error(
      "Pinned API snapshot differs; existing cache was not replaced",
    );
  await fs.mkdir(root, { recursive: true });
  await directory(root);
  await fs.mkdir(path.join(root, "snapshots"), { recursive: true });
  await directory(path.join(root, "snapshots"));
  const stage = await fs.mkdtemp(path.join(root, ".stage-"));
  const pointer = path.join(root, `.current-${randomUUID()}`);
  try {
    await fs.mkdir(path.join(stage, "adsk"));
    for (const [name, bytes] of Object.entries(outputs))
      await fs.writeFile(path.join(stage, name), bytes, { flag: "wx" });
    await fs.writeFile(path.join(stage, "manifest.json"), serialized, {
      flag: "wx",
    });
    await verifySnapshot(stage, serialized, outputs);
    const destination = path.join(root, "snapshots", id);
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" &&
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      )
        throw error;
      await verifySnapshot(destination, serialized, outputs);
    }
    await fs.writeFile(pointer, JSON.stringify({ snapshot: id }) + "\n", {
      flag: "wx",
    });
    await fs.rename(pointer, path.join(root, "current.json"));
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(pointer, { force: true });
  }
  return manifest;
}
async function verifySnapshot(
  dir: string,
  manifest: Buffer,
  outputs: Record<string, Buffer>,
): Promise<void> {
  await directory(dir);
  await directory(path.join(dir, "adsk"));
  if (
    JSON.stringify((await fs.readdir(path.join(dir, "adsk"))).sort()) !==
      JSON.stringify([...modules].sort()) ||
    JSON.stringify((await fs.readdir(dir)).sort()) !==
      JSON.stringify(
        [
          "adsk",
          "LICENSE.upstream",
          "README.upstream.md",
          "NOTICES.md",
          "manifest.json",
        ].sort(),
      )
  )
    throw new Error("Unexpected existing snapshot files");
  for (const [name, bytes] of Object.entries({
    ...outputs,
    "manifest.json": manifest,
  }))
    if (!(await regular(path.join(dir, name))).equals(bytes))
      throw new Error("Existing snapshot corrupt");
}
