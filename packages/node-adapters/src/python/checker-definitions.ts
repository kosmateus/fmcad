import { createHash } from "node:crypto";
import { lstat, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const checkerHash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export function checkerObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected checker JSON object");
  return value as Record<string, unknown>;
}

async function regular(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error("Invalid typing resource: " + file);
  return readFile(file);
}

/** Consume the immutable build producer's contract; never refresh or import it. */
export async function stageCheckerDefinitions(
  root: string,
  target: string,
): Promise<string> {
  const pointer = checkerObject(
    JSON.parse(
      (await regular(join(root, "current.json"))).toString(),
    ) as unknown,
  );
  const snapshot = pointer["snapshot"];
  if (typeof snapshot !== "string" || !/^[a-f0-9]{64}$/.test(snapshot))
    throw new Error("Invalid definitions pointer");
  const directory = join(root, "snapshots", snapshot);
  const raw = await regular(join(directory, "manifest.json"));
  if (checkerHash(raw) !== snapshot)
    throw new Error("Definitions manifest hash mismatch");
  const manifest = checkerObject(JSON.parse(raw.toString()) as unknown);
  if (
    manifest["schema"] !== 1 ||
    manifest["repository"] !== "AutodeskFusion360/FusionAPIReference" ||
    manifest["generator"] !== "fmcad-annotated-copy-v1" ||
    manifest["overlay"] !== "point3d-nullable-v1" ||
    manifest["authorization"] !==
      "user-authorized-2026-10-24; Autodesk rights unverified; not legal clearance" ||
    typeof manifest["commit"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest["commit"])
  )
    throw new Error("Unsupported definitions producer/provenance");
  const files = checkerObject(manifest["files"]);
  const modules = [
    "__init__.py",
    "cam.py",
    "core.py",
    "drawing.py",
    "electron.py",
    "fusion.py",
    "sim.py",
    "volume.py",
  ];
  const names = [
    ...modules.map((name) => `adsk/${name}`),
    "LICENSE.upstream",
    "README.upstream.md",
    "NOTICES.md",
  ].sort();
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(names))
    throw new Error("Incomplete definitions inventory");
  let bytes = 0;
  await mkdir(join(target, "adsk"), { recursive: true });
  for (const name of names) {
    const data = await regular(join(directory, name));
    bytes += data.length;
    if (bytes > 24 * 1024 * 1024 || checkerHash(data) !== files[name])
      throw new Error("Definitions content hash/size mismatch: " + name);
    if (name.startsWith("adsk/")) await writeFile(join(target, name), data);
  }
  return snapshot;
}
