// @ts-check
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

/** Extend the qualified SDK-free native program without copying its guards.
 * @param {string} controlledNative
 * @returns {string}
 */
function deadRegisteredNative(controlledNative) {
  const definitions = "# NORMAL_OBSERVER_PRIVATE_EXTENSION";
  const dispatch = '    if action == "preflight":';
  assert.equal(controlledNative.split(definitions).length, 2,
    "Pinned native definitions boundary changed");
  assert.equal(controlledNative.split(dispatch).length, 2,
    "Pinned native dispatch boundary changed");
  const module = fs.readFileSync(path.join(__dirname, "dead_registered_handoff.py"), "utf8");
  const native = fs.readFileSync(path.join(__dirname, "dead_registered_handoff_native.py"), "utf8");
  return controlledNative
    .replace(definitions, definitions + "\n" + module + "\n" + native)
    .replace(dispatch,
      '    if action == "dead-registered-handoff":\n' +
      "        result = dead_registered_handoff(source)\n" +
      '    elif action == "preflight":');
}
module.exports = { deadRegisteredNative };
