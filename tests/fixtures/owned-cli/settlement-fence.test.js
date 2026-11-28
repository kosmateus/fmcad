"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { docName, fmcad, skipLive } = require("../../integration/helper");

test("owned child CLI dispatches two settled commands", (t) => {
  if (skipLive(t)) return;
  for (let index = 0; index < 2; index++) {
    const result = fmcad(["document", "status", "--doc", docName()]);
    assert.equal(result.success, true);
    assert.equal(result.result.creationId, "fence-document");
  }
});
