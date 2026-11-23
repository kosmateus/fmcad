"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readRegularFile(filename, label) {
  let fd;
  try {
    fd = fs.openSync(
      filename,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || fs.realpathSync(filename) !== filename) {
      throw new Error(`${label} must be a canonical regular file: ${filename}`);
    }
    return fs.readFileSync(fd, "utf8");
  } catch {
    throw new Error(
      `${label} is missing or unreadable; no queue SDK was loaded: ${filename}`,
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readJson(filename, label) {
  try {
    return JSON.parse(readRegularFile(filename, label));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${label} is invalid; no queue SDK was loaded: ${filename}`,
      );
    }
    throw error;
  }
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/** Resolve only the explicitly selected installed runtime and bind its manifest to its bytes. */
function resolveQualifiedLiveRuntime(env = process.env) {
  const selected = env.FMCAD_LIVE_RUNTIME_ROOT;
  if (typeof selected !== "string" || !selected.trim()) {
    throw new Error(
      "FMCAD_LIVE_RUNTIME_ROOT must name the qualified installed runtime; no queue SDK was loaded.",
    );
  }
  if (!path.isAbsolute(selected)) {
    throw new Error(
      "FMCAD_LIVE_RUNTIME_ROOT must be an absolute path; no queue SDK was loaded.",
    );
  }

  let root;
  try {
    root = fs.realpathSync(selected);
  } catch {
    throw new Error(
      `FMCAD_LIVE_RUNTIME_ROOT cannot be resolved; no queue SDK was loaded: ${selected}`,
    );
  }
  const rootPackagePath = path.join(root, "package.json");
  const rootPackage = fs.lstatSync(rootPackagePath, { throwIfNoEntry: false })
    ? record(
        readJson(rootPackagePath, "Installed package manifest"),
        "Installed package manifest",
      )
    : undefined;
  // A staged distribution is itself the runtime root; a source installation
  // keeps the same immutable distribution under dist. Never fall back after
  // selecting a distribution marker, even when its validation later fails.
  const dist =
    rootPackage && Object.hasOwn(rootPackage, "fmcadRuntimeLayout")
      ? root
      : path.join(root, "dist");
  const packagePath = path.join(dist, "package.json");
  const packageManifest = record(
    readJson(packagePath, "Installed package manifest"),
    "Installed package manifest",
  );
  if (
    packageManifest.name !== "fmcad" ||
    packageManifest.fmcadRuntimeLayout !== 1
  ) {
    throw new Error(
      "FMCAD_LIVE_RUNTIME_ROOT does not identify an installed fmcad runtime; no queue SDK was loaded.",
    );
  }

  const manifestPath = path.join(dist, "runtime-build.json");
  const manifest = record(
    readJson(manifestPath, "Runtime build manifest"),
    "Runtime build manifest",
  );
  const fingerprint = manifest.fingerprint;
  const entrypoints = record(manifest.entrypoints, "Runtime build entrypoints");
  if (
    manifest.version !== 1 ||
    manifest.algorithm !== "sha256" ||
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    !["queue-worker", "queue-autostart-worker", "queue-broker"].every(
      (name) =>
        typeof entrypoints[name] === "string" && entrypoints[name].length > 0,
    )
  ) {
    throw new Error(
      "Runtime build manifest is missing a valid immutable fingerprint chain; no queue SDK was loaded.",
    );
  }

  const queueInstancePath = path.join(dist, "src/queue-instance.js");
  readRegularFile(queueInstancePath, "Installed queue identity module");
  const runtime = require(queueInstancePath);
  if (typeof runtime.buildHash !== "function") {
    throw new Error(
      "Installed queue identity module has no buildHash(); no queue SDK was loaded.",
    );
  }
  let actualFingerprint;
  try {
    actualFingerprint = runtime.buildHash();
  } catch (error) {
    throw new Error(
      "Installed runtime fingerprint could not be verified; no queue SDK was loaded.",
      { cause: error },
    );
  }
  if (actualFingerprint !== fingerprint) {
    throw new Error(
      `Installed runtime bytes do not match ${dist === root ? "runtime-build.json" : "dist/runtime-build.json"}; no queue SDK was loaded.`,
    );
  }

  return Object.freeze({
    root,
    dist,
    fingerprint,
    manifestPath,
    queueInstancePath,
  });
}

module.exports = { resolveQualifiedLiveRuntime };
