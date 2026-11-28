import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

type BundleModule = {
  readonly id: string;
  readonly path: string;
  readonly compatibilityPath?: string;
  readonly dependencies: readonly string[];
  readonly owner?: string;
};
type PackedPackage = {
  filename: string;
  files: Array<{ path: string; size: number }>;
};
type InstalledPreparation = {
  installation: string;
  manifest: BundleModule[];
  fullUnits: Array<{
    id: string;
    filename: string;
    sourceSha256: string;
    sourceBytes: number;
  }>;
  prepared: {
    artifactSha256: string;
    artifactHash: string;
    scriptBytes: number;
    runtimeSourceBytes: number;
    payloadPaths: string[];
    units: Array<{
      id: string;
      filename: string;
      role: string;
      sha256: string;
      selectionInputSha256: string | null;
      sourceBytes: number;
    }>;
  };
  checkerSha256: string;
};

const projectRoot = path.resolve(process.cwd());
const workspaceRequire = createRequire(path.join(projectRoot, "package.json"));
const { cadBundleManifest } = workspaceRequire(
  "./packages/node-adapters/dist/python/bundle-inventory.js",
) as { cadBundleManifest: readonly BundleModule[] };
const preparationSupportSources = [
  "runtime/python/entrypoints/dependency_facts.py",
];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pythonSourcePaths(manifest: readonly BundleModule[]): string[] {
  return [
    ...new Set([
      ...manifest.flatMap((unit) =>
        unit.compatibilityPath
          ? [unit.path, unit.compatibilityPath]
          : [unit.path],
      ),
      ...preparationSupportSources,
    ]),
  ].sort();
}

function declaredAssetPaths(manifest: readonly BundleModule[]): string[] {
  return manifest
    .map((unit) => unit.compatibilityPath ?? unit.path)
    .filter((sourcePath) => sourcePath.startsWith("assets/cad/"))
    .map((sourcePath) => sourcePath.slice("assets/cad/".length))
    .sort();
}

function assetPythonInventory(runtimeRoot: string): string[] {
  return fs
    .readdirSync(path.join(runtimeRoot, "assets/cad"), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => entry.name)
    .sort();
}

function assertCanonicalPythonSources(
  runtimeRoot: string,
  manifest: readonly BundleModule[],
): void {
  assert.deepEqual(
    assetPythonInventory(runtimeRoot),
    declaredAssetPaths(manifest),
    "Packaged assets/cad inventory differs from the canonical Python manifest",
  );
  for (const sourcePath of pythonSourcePaths(manifest)) {
    const canonicalPath = path.join(projectRoot, sourcePath);
    const packagedPath = path.join(runtimeRoot, sourcePath);
    if (!fs.existsSync(packagedPath))
      throw new Error(`Missing required packaged Python source: ${sourcePath}`);
    const canonical = fs.readFileSync(canonicalPath);
    const packaged = fs.readFileSync(packagedPath);
    if (!packaged.equals(canonical))
      throw new Error(
        `Canonical Python source mismatch: ${sourcePath}; expected=${sha256(canonical)} packaged=${sha256(packaged)}`,
      );
  }
}

function sourceInventoryEvidence(manifest: readonly BundleModule[]) {
  const paths = pythonSourcePaths(manifest);
  const hash = createHash("sha256");
  let rawBytes = 0;
  for (const sourcePath of paths) {
    const bytes = fs.readFileSync(path.join(projectRoot, sourcePath));
    rawBytes += bytes.byteLength;
    hash.update(sourcePath).update("\0").update(bytes).update("\0");
  }
  return { paths, rawBytes, sha256: hash.digest("hex") };
}

const installedPreparationScript = String.raw`
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.env.FMCAD_TEST_INSTALLED_RUNTIME_ROOT;
assert.ok(runtime);
const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
const cad = runtimeRequire('./src/cad.js');
const python = runtimeRequire('./src/python.js');
const paths = runtimeRequire('./src/dist/config-platform').resolveRuntimePaths({
  anchor: path.join(runtime, 'src/cad.js'),
  env: {},
});
assert.equal(paths.installation, runtime);
assert.notEqual(path.resolve(process.cwd()), path.resolve(runtime));
assert.equal(process.env.NODE_PATH, undefined);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const artifact = cad.prepareCadScript('document.status', {}, {
  doc: 'Installed Python package closure',
  docId: 'python-library-package-closure',
});
python.verifyPythonArtifact(artifact);
const manifest = python.cadBundleManifest;
const full = python.cadBundleUnits(runtime, 'full');
const preparationInputs = python.cadBundleUnits(runtime, 'document-status');
const runtimeUnits = artifact.units.filter((unit) => unit.role === 'runtime');
const units = artifact.units.map((unit) => {
  const input = preparationInputs.find((candidate) => candidate.id === unit.id);
  if (unit.role === 'runtime') {
    const declared = manifest.find((candidate) => candidate.id === unit.id);
    assert.ok(declared, 'Prepared runtime unit is absent from the installed manifest: ' + unit.id);
    assert.equal(unit.filename, declared.path);
    assert.ok(input, 'Prepared unit has no installed manifest source: ' + unit.id);
    const selectionInputSha256 = hash(input.source);
    assert.equal(hash(unit.source), unit.sha256);
    if (unit.source !== input.source)
      assert.ok(
        unit.source.includes('original-sha256=' + selectionInputSha256),
        'Changed source is missing original-source provenance: ' + unit.id,
      );
    return {
      id: unit.id,
      filename: unit.filename,
      role: unit.role,
      sha256: unit.sha256,
      selectionInputSha256,
      sourceBytes: Buffer.byteLength(unit.source, 'utf8'),
    };
  }
  assert.equal(hash(unit.source), unit.sha256);
  return {
    id: unit.id,
    filename: unit.filename,
    role: unit.role,
    sha256: unit.sha256,
    selectionInputSha256: null,
    sourceBytes: Buffer.byteLength(unit.source, 'utf8'),
  };
});
const checker = path.join(runtime, 'src/dist/python/checker.js');
assert.ok(fs.statSync(checker).isFile());
process.stdout.write(JSON.stringify({
  installation: paths.installation,
  manifest,
  fullUnits: full.map((unit) => ({
    id: unit.id,
    filename: unit.filename,
    sourceSha256: hash(unit.source),
    sourceBytes: Buffer.byteLength(unit.source, 'utf8'),
  })),
  prepared: {
    artifactSha256: artifact.sha256,
    artifactHash: artifact.artifactHash,
    scriptBytes: Buffer.byteLength(artifact.script, 'utf8'),
    runtimeSourceBytes: runtimeUnits.reduce(
      (total, unit) => total + Buffer.byteLength(unit.source, 'utf8'),
      0,
    ),
    payloadPaths: runtimeUnits.map((unit) => unit.filename),
    units,
  },
  checkerSha256: hash(fs.readFileSync(checker)),
}));
`;

function runInstalledPreparation(
  runtimeRoot: string,
  consumerDirectory: string,
) {
  const home = path.join(consumerDirectory, "home");
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    FMCAD_TEST_INSTALLED_RUNTIME_ROOT: runtimeRoot,
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
  };
  delete env["NODE_PATH"];
  delete env["FMCAD_CI_PACKAGE_TARBALL"];
  return spawnSync(process.execPath, ["-e", installedPreparationScript], {
    cwd: consumerDirectory,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

test("actual npm tarball enforces canonical Python source closure before SDK execution", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(tmpdir(), "python-library-package-closure-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const buildManifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "dist/runtime-build.json"), "utf8"),
  ) as { fingerprint?: unknown };
  assert.equal(typeof buildManifest.fingerprint, "string");

  const packDirectory = path.join(temporaryRoot, "pack");
  const extractedDirectory = path.join(temporaryRoot, "extracted");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(packDirectory);
  fs.mkdirSync(extractedDirectory);
  fs.mkdirSync(consumerDirectory);
  fs.writeFileSync(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "python-package-closure-consumer", private: true }),
  );

  const npmEnv: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_offline: "true",
    npm_config_userconfig: "/dev/null",
  };
  delete npmEnv["NODE_PATH"];
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      {
        cwd: projectRoot,
        env: npmEnv,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  ) as PackedPackage[];
  assert.ok(packed, "npm pack did not create a package");
  const tarballPath = path.resolve(packDirectory, packed.filename);
  assert.ok(fs.existsSync(tarballPath), "npm pack tarball is missing");
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractedDirectory]);

  const extractedPackage = path.join(extractedDirectory, "package");
  const extractedRuntime = path.join(extractedPackage, "dist");
  const requiredPaths = pythonSourcePaths(cadBundleManifest);
  const packedPaths = new Set(packed.files.map((file) => file.path));
  for (const sourcePath of requiredPaths)
    assert.ok(
      packedPaths.has(path.posix.join("dist", sourcePath)),
      `Tarball omits required Python source ${sourcePath}`,
    );
  for (const entrypoint of [
    "dist/runtime-build.json",
    "dist/src/cad.js",
    "dist/src/python.js",
    "dist/src/dist/python/bundle-inventory.js",
    "dist/src/dist/python/checker.js",
  ])
    assert.ok(packedPaths.has(entrypoint), `Tarball omits ${entrypoint}`);
  assertCanonicalPythonSources(extractedRuntime, cadBundleManifest);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(extractedRuntime, "runtime-build.json"),
        "utf8",
      ),
    ),
    buildManifest,
  );

  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerDirectory,
      tarballPath,
    ],
    {
      cwd: consumerDirectory,
      env: npmEnv,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const installedPackage = path.join(consumerDirectory, "node_modules/fmcad");
  const installedRuntime = path.join(installedPackage, "dist");
  assert.ok(fs.existsSync(installedPackage), "Tarball was not installed");
  assert.equal(
    fs.lstatSync(installedPackage).isSymbolicLink(),
    false,
    "Installed package must not link back to the source checkout",
  );
  assertCanonicalPythonSources(installedRuntime, cadBundleManifest);
  for (const relativePath of [
    "dist/runtime-build.json",
    "dist/src/cad.js",
    "dist/src/python.js",
    "dist/src/dist/python/bundle-inventory.js",
    "dist/src/dist/python/checker.js",
  ])
    assert.deepEqual(
      fs.readFileSync(path.join(installedPackage, relativePath)),
      fs.readFileSync(path.join(extractedPackage, relativePath)),
      `${relativePath} changed between the unpacked tarball and installed package`,
    );

  const preparation = runInstalledPreparation(
    installedRuntime,
    consumerDirectory,
  );
  assert.equal(preparation.status, 0, preparation.stderr);
  const installed = JSON.parse(preparation.stdout) as InstalledPreparation;
  assert.equal(installed.installation, installedRuntime);
  assert.deepEqual(installed.manifest, cadBundleManifest);
  assert.deepEqual(
    installed.fullUnits.map(({ id }) => id).sort(),
    cadBundleManifest.map(({ id }) => id).sort(),
    "Installed full source inventory differs from the canonical manifest",
  );
  for (const unit of installed.fullUnits) {
    const declared = cadBundleManifest.find((entry) => entry.id === unit.id);
    assert.ok(declared);
    assert.equal(unit.filename, declared.path);
  }
  const checkerSha256 = sha256(
    fs.readFileSync(path.join(installedRuntime, "src/dist/python/checker.js")),
  );
  assert.equal(installed.checkerSha256, checkerSha256);

  await t.test(
    "missing required packaged Python source fails during installed preparation",
    () => {
      const missingPath = declaredAssetPaths(cadBundleManifest)[0];
      assert.ok(missingPath);
      const missingFile = path.join(
        installedRuntime,
        "assets/cad",
        missingPath,
      );
      const original = fs.readFileSync(missingFile);
      try {
        fs.rmSync(missingFile);
        const result = runInstalledPreparation(
          installedRuntime,
          consumerDirectory,
        );
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stderr, /Incomplete Python bundle inventory/);
      } finally {
        fs.writeFileSync(missingFile, original);
      }
    },
  );

  await t.test(
    "stale generated source is rejected before installed preparation",
    () => {
      const stalePath = requiredPaths.find((sourcePath) =>
        sourcePath.startsWith("assets/cad/"),
      );
      assert.ok(stalePath);
      const staleFile = path.join(installedRuntime, stalePath);
      const original = fs.readFileSync(staleFile);
      const stale = fs.readFileSync(
        path.join(
          projectRoot,
          "tests/fixtures/python-package-closure/stale-generated.py",
        ),
      );
      try {
        fs.writeFileSync(staleFile, stale);
        let installedPreparationReached = false;
        assert.throws(() => {
          assertCanonicalPythonSources(installedRuntime, cadBundleManifest);
          installedPreparationReached = true;
        }, /Canonical Python source mismatch/);
        assert.equal(
          installedPreparationReached,
          false,
          "A stale generated source must fail the closure check before preparation",
        );
      } finally {
        fs.writeFileSync(staleFile, original);
      }
    },
  );

  const sourceEvidence = sourceInventoryEvidence(cadBundleManifest);
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  t.diagnostic(
    JSON.stringify({
      sourceCommit,
      npmVersion: execFileSync("npm", ["--version"], {
        encoding: "utf8",
        env: npmEnv,
      }).trim(),
      runtimeBuildFingerprint: buildManifest.fingerprint,
      tarballSha256: sha256(fs.readFileSync(tarballPath)),
      pythonInventorySha256: sourceEvidence.sha256,
      pythonSourceFileCount: sourceEvidence.paths.length,
      rawPythonSourceBytes: sourceEvidence.rawBytes,
      checkerPath: "dist/src/dist/python/checker.js",
      checkerSha256,
      preparedArtifactSha256: installed.prepared.artifactSha256,
      preparedArtifactHash: installed.prepared.artifactHash,
      preparedRuntimeSourceBytes: installed.prepared.runtimeSourceBytes,
      preparedScriptBytes: installed.prepared.scriptBytes,
      preparedPayloadPaths: installed.prepared.payloadPaths,
      preparedSourceUnitHashes: installed.prepared.units,
      installedPreparation: "passed; no SDK invoked",
      missingSourceNegative: "rejected before SDK",
      staleSourceNegative: "rejected before installed preparation or SDK",
    }),
  );
});
