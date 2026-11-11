const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const manifestPath = ".test-artifacts/ci-build/manifest.json";
const packagePath = ".test-artifacts/ci-build/fmcad-package.tgz";
const definitionsPointer = "dist/runtime/python/typing/current.json";
const stagedFixtures = [
  "dist/tests/fixtures/atomic-audit-upgrade.cjs",
  "dist/tests/fixtures/epoch-audit.cjs",
  "dist/tests/fixtures/fake-wsl-platform.cjs",
  "dist/tests/fixtures/fake-wsl-preload.cjs",
];
const requiredGeneratedFiles = [
  "bin/fmcad.js",
  "bin/fmcad-mcp.js",
  "scripts/assemble-native-evidence.cjs",
  "scripts/install-queue-phases.js",
  "scripts/migrate-project-log.js",
  "scripts/recover-local-build-preflight.js",
];

function verify(root, expectedSha, expected = {}) {
  if (!/^[a-f0-9]{40}$/i.test(expectedSha || ""))
    throw new Error("Invalid expected CI build source SHA");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, manifestPath), "utf8"),
  );
  if (manifest.schema !== 1)
    throw new Error("Unsupported CI build artifact manifest schema");
  if (manifest.sourceSha !== expectedSha.toLowerCase())
    throw new Error(
      `CI build artifact source SHA mismatch: expected ${expectedSha}, got ${manifest.sourceSha}`,
    );
  if (
    !manifest.toolchain ||
    !new RegExp(`^v${expected.nodeMajor || 24}\\.`).test(
      manifest.toolchain.node || "",
    ) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.toolchain.npm || "") ||
    manifest.toolchain.platform !== (expected.platform || process.platform) ||
    manifest.toolchain.arch !== (expected.arch || process.arch)
  )
    throw new Error(
      "CI build artifact toolchain does not match the expected build",
    );
  if (!Array.isArray(manifest.outputs))
    throw new Error("CI build artifact output manifest is missing");
  for (const output of manifest.outputs) {
    if (
      typeof output !== "string" ||
      path.isAbsolute(output) ||
      output.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid path in CI build artifact output manifest");
    fs.lstatSync(path.join(root, output));
  }
  if (!manifest.outputs.includes("dist"))
    throw new Error("CI build artifact omits the emitted runtime tree");
  if (
    !Array.isArray(manifest.requiredFiles) ||
    !manifest.requiredFiles.includes(definitionsPointer) ||
    !stagedFixtures.every((file) => manifest.requiredFiles.includes(file)) ||
    !requiredGeneratedFiles.every((file) => manifest.outputs.includes(file)) ||
    !requiredGeneratedFiles.every((file) =>
      manifest.requiredFiles.includes(file),
    )
  )
    throw new Error("CI build artifact omits required generated files");
  if (!manifest.requiredFiles.includes(packagePath))
    throw new Error("CI build artifact omits the prepared npm package");
  for (const file of manifest.requiredFiles) {
    if (
      typeof file !== "string" ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid required path in CI build artifact manifest");
    fs.lstatSync(path.join(root, file));
  }
  const pointer = JSON.parse(
    fs.readFileSync(path.join(root, definitionsPointer), "utf8"),
  );
  if (!/^[a-f0-9]{64}$/.test(pointer.snapshot || ""))
    throw new Error(
      "CI build artifact has an invalid generated definitions pointer",
    );
  const packageFile = path.join(root, packagePath);
  const packageSha = createHash("sha256")
    .update(fs.readFileSync(packageFile))
    .digest("hex");
  const sourcePackage = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (
    manifest.package?.file !== packagePath ||
    manifest.package?.name !== sourcePackage.name ||
    manifest.package?.version !== sourcePackage.version ||
    packageSha !== manifest.package?.sha256
  )
    throw new Error("CI build artifact package does not match its manifest");
  return manifest;
}

module.exports = { verify };
if (require.main === module) {
  const sourceSha = process.env["FMCAD_CI_SOURCE_SHA"];
  if (!sourceSha) throw new Error("FMCAD_CI_SOURCE_SHA is required");
  verify(path.resolve(__dirname, "../.."), sourceSha);
}
