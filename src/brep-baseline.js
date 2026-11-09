"use strict";
const {
  createBrepExecutor,
  publicOperations,
} = require("./dist/node-adapters/persistence/brep-baseline-service");
const { authorize } = require("./catalog/brep-baseline-internal");
module.exports = { execute: createBrepExecutor(authorize), publicOperations };
