"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const current = require("../src/cad");
const original = require("./fixtures/historical-module.cjs")(
  "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  "src/cad.js",
);

function execute(api, reply) {
  const calls = [];
  const pending = api.executeCad(
    {
      async callTool(request) {
        calls.push(request);
        return reply;
      },
    },
    "document.status",
    {},
    { doc: "Owned model", docId: "owned-creation" },
  );
  return { pending, calls };
}

for (const tail of ['{"success":false}', '{"success":true}']) {
  test(`CAD rejects inherited duplicate result acceptance: ${tail}`, async () => {
    const reply = {
      text: 'FMCAD_RESULT {"success":true}\nFMCAD_RESULT ' + tail,
    };
    const before = execute(original, reply);
    assert.deepEqual(await before.pending, { success: true });
    assert.equal(before.calls.length, 1);
    const after = execute(current, reply);
    await assert.rejects(
      after.pending,
      (error) => error.unknown === true && /exactly one/.test(error.message),
    );
    assert.equal(after.calls.length, 1);
  });
}

for (const text of [
  "FMCAD_RESULT null",
  "FMCAD_RESULT []",
  "FMCAD_RESULT 0",
  "FMCAD_RESULT true",
  "FMCAD_RESULT {}\nFMCAD_RESULT {",
]) {
  test(`CAD marks unusable result evidence unknown without replay: ${text}`, async () => {
    const result = execute(current, { text });
    await assert.rejects(result.pending, (error) => error.unknown === true);
    assert.equal(result.calls.length, 1);
  });
}

for (const reply of [
  { text: "progress without a result" },
  { text: "FMCAD_RESULT {" },
  { text: 'FMCAD_RESULT {"success":true}', failed: true },
]) {
  test(`CAD preserves failure evidence and classifies an unsettled reply: ${reply.text}`, async () => {
    const before = execute(original, reply);
    let originalMessage;
    await assert.rejects(before.pending, (error) => {
      originalMessage = error.message;
      return error.unknown === undefined;
    });
    const after = execute(current, reply);
    await assert.rejects(
      after.pending,
      (error) => error.unknown === true && error.message === originalMessage,
    );
    assert.equal(before.calls.length, 1);
    assert.equal(after.calls.length, 1);
  });
}

test("CAD retains an ordinary result and a native failed result without interpreting progress as results", async () => {
  for (const value of [
    { success: true, result: { count: 1 } },
    { success: false, result: { status: "failed" } },
  ]) {
    const reply = {
      text:
        'FMCAD_PROGRESS {"state":"started"}\r\nFMCAD_RESULT ' +
        JSON.stringify(value) +
        "\r\n",
    };
    const before = execute(original, reply),
      after = execute(current, reply);
    assert.deepEqual(await after.pending, await before.pending);
    assert.deepEqual(await after.pending, value);
    assert.equal(before.calls.length, 1);
    assert.equal(after.calls.length, 1);
  }
});
