import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface RuntimeBinding {
  readonly root: string;
  readonly fingerprint: string;
}

interface RuntimeLoader {
  resolveQualifiedLiveRuntime(env: NodeJS.ProcessEnv): RuntimeBinding;
}

interface PackedPackage {
  readonly name: string;
  readonly filename: string;
}

interface RuntimeManifest {
  readonly fingerprint: string;
}

interface ApiLock {
  readonly snapshot: string;
}

interface ApiSnapshot {
  readonly snapshot: string;
}

export interface InstalledChildCliRuntime {
  readonly root: string;
  readonly fingerprint: string;
  close(): void;
}

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(filename, "utf8")) as T;
}

function sourceFingerprint(projectRoot: string): string {
  const lock = readJson<ApiLock>(
      path.join(projectRoot, "scripts/adsk-refresh/api-lock.json"),
    ),
    snapshot = readJson<ApiSnapshot>(
      path.join(projectRoot, "dist/runtime/python/typing/current.json"),
    ),
    manifest = readJson<RuntimeManifest>(
      path.join(projectRoot, "dist/runtime-build.json"),
    ),
    instance = createRequire(path.join(projectRoot, "package.json"))(
      "./dist/src/queue-instance.js",
    ) as { buildHash(): string },
    actual = instance.buildHash();
  if (snapshot.snapshot !== lock.snapshot)
    throw new Error(
      "Child CLI package preparation requires the pinned API definitions; run npm run build first",
    );
  if (
    typeof manifest.fingerprint !== "string" ||
    manifest.fingerprint !== actual
  )
    throw new Error(
      "The checkout runtime fingerprint does not match its built manifest",
    );
  return actual;
}

function packageArtifact(projectRoot: string, work: string): string {
  const configured = process.env["FMCAD_CI_PACKAGE_TARBALL"];
  let artifact: string;
  if (configured !== undefined) {
    if (!configured.trim())
      throw new Error(
        "FMCAD_CI_PACKAGE_TARBALL must name the prepared package",
      );
    artifact = path.resolve(projectRoot, configured);
  } else {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", work],
        {
          cwd: projectRoot,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    ) as PackedPackage[];
    if (
      packed.length !== 1 ||
      packed[0]?.name !== "fmcad" ||
      typeof packed[0].filename !== "string" ||
      path.basename(packed[0].filename) !== packed[0].filename
    )
      throw new Error("npm pack did not produce the expected fmcad package");
    artifact = path.join(work, packed[0].filename);
  }
  const stat = fs.lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The prepared child CLI package must be a regular file");
  return fs.realpathSync(artifact);
}

/** Install the exact prepared package in a private temporary prefix and pin its bytes. */
export function installChildCliRuntime(
  projectRoot: string,
): InstalledChildCliRuntime {
  const expectedFingerprint = sourceFingerprint(projectRoot),
    temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-child-cli-runtime-"),
    ),
    work = path.join(temporary, "package");
  fs.mkdirSync(work, { mode: 0o700 });
  try {
    const artifact = packageArtifact(projectRoot, work),
      prefix = path.join(temporary, "install");
    fs.mkdirSync(prefix, { mode: 0o700 });
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--prefix",
        prefix,
        artifact,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const root = path.join(prefix, "node_modules/fmcad"),
      stat = fs.lstatSync(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(root) !== root
    )
      throw new Error("The installed child CLI package is not canonical");
    const loader = createRequire(path.join(projectRoot, "package.json"))(
      "./tests/helpers/qualified-live-runtime",
    ) as RuntimeLoader;
    const binding = loader.resolveQualifiedLiveRuntime({
      FMCAD_LIVE_RUNTIME_ROOT: root,
    });
    if (binding.fingerprint !== expectedFingerprint)
      throw new Error(
        "The installed child CLI package does not match the checkout build fingerprint",
      );
    return Object.freeze({
      root: binding.root,
      fingerprint: binding.fingerprint,
      close() {
        fs.rmSync(temporary, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
