"use strict";
// Compatibility composition. Keep the caller's runtime anchor in this facade.
const configuration = require("./dist/composition/library-configuration.js");
const platform = require("./dist/config-platform/index.js");
module.exports = {
  ...configuration,
  resolveRuntimePaths: options => platform.resolveRuntimePaths({ anchor: __filename, ...options }),
};
