"use strict";
const {
  createDrawingChecker,
} = require("./dist/node-adapters/persistence/drawing-check");
module.exports = createDrawingChecker(require("./drawing-package"));
