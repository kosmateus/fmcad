"use strict";
const {
  createDrawingExporter,
} = require("./dist/node-adapters/persistence/drawing-export");
module.exports = createDrawingExporter(require("./drawing-package"));
