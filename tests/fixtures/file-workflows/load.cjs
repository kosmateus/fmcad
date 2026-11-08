"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
module.exports = (label, sourcePath, overrides = {}) => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"),
  );
  const fixture = manifest.find(
    (row) => row.file.startsWith(label + "-") && row.sourcePath === sourcePath,
  );
  if (!fixture || path.basename(fixture.file) !== fixture.file)
    throw new Error("Unregistered file workflow history");
  const bytes = fs.readFileSync(path.join(__dirname, fixture.file));
  if (
    crypto.createHash("sha256").update(bytes).digest("hex") !== fixture.sha256
  )
    throw new Error("File workflow history hash mismatch");
  const filename = path.resolve(__dirname, "../../..", sourcePath);
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  const load = Module.createRequire(filename);
  isolated.require = (id) =>
    Object.hasOwn(overrides, id) ? overrides[id] : load(id);
  isolated._compile(bytes.toString("utf8"), filename);
  return isolated.exports;
};
