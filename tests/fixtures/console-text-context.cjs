"use strict";
// Text formatting boundary for retained domain/detail assertions. No screen, DOM,
// navigation or operation semantics are replaced by this test context.
const { label } = require("../../src/console-labels");
const { en, t, duration } = require("../../src/i18n");
function textContext(language = "en") {
  const L = (key) => label(key, language);
  return {
    language,
    L,
    statusText: (value) =>
      en["state_" + value]
        ? t("state_" + value, {}, language)
        : value == null || value === ""
          ? L("unknown")
          : String(value),
    date: (value) => {
      const parsed =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Date.parse(value)
            : NaN;
      return Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : L("unknown");
    },
    duration: (value) => duration(value, language),
    tone: () => "text",
  };
}
module.exports = { textContext };
