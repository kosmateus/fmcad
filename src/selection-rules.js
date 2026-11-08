"use strict";
const {
  createSelectionExecutor,
  publicOperations,
} = require("./dist/node-adapters/persistence/selection-service");
const { selectionRulesInternal } = require("./catalog");
module.exports = {
  execute: createSelectionExecutor(selectionRulesInternal.authorize),
  publicOperations,
};
