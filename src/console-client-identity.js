"use strict";
// Compatibility facade; all identity and measured-presence semantics are typed.
const {
  clientKind,
  presenceText,
  presenceSummary,
  identityCounts,
} = require("./dist/core");
module.exports = { clientKind, presenceText, presenceSummary, identityCounts };
