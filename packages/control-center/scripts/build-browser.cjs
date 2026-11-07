"use strict";
// Bootstrap only; the strict TypeScript devtools build owns packaging.
const path = require("node:path");
const build = require("../../../dist/scripts/devtools/build-browser.js");
function buildBrowserAssets() {
  return build.buildBrowserAssets(path.resolve(__dirname, "../../.."));
}
if (require.main === module) buildBrowserAssets();
module.exports = { buildBrowserAssets };
