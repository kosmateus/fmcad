"use strict";
const { kindOf, correlate, describeConsoleRow: describe, refreshConsoleDetail } = require("./dist/core");
const refresh = (modal, model) => refreshConsoleDetail(modal, model, structuredClone);
module.exports = { kindOf, correlate, describe, refresh };
