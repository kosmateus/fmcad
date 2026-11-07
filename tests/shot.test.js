"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { shotCmd } = require("../src/shot");

test("dedicated shot adapter preserves capture options and writes decoded image bytes", async () => {
  const writes = [],
    calls = [],
    stdout = [],
    stderr = [];
  const client = {
    callTool: async (...args) => {
      calls.push(args);
      return {
        data: { base64Data: Buffer.from("png-fixture").toString("base64") },
      };
    },
  };
  const files = {
    writeFileSync: (file, bytes) =>
      writes.push([file, Buffer.from(bytes).toString()]),
  };
  const io = {
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
  };

  assert.equal(
    await shotCmd(
      client,
      [
        "--out",
        "review.png",
        "--dir",
        "iso-top-right",
        "--width",
        "1280",
        "--height",
        "720",
        "--no-aa",
        "--transparent",
      ],
      io,
      files,
    ),
    0,
  );
  assert.deepEqual(calls[0], [
    {
      queryType: "screenshot",
      direction: "iso-top-right",
      width: 1280,
      height: 720,
      antiAliasing: false,
      transparentBackground: true,
    },
    "fusion_mcp_read",
  ]);
  assert.deepEqual(writes, [["review.png", "png-fixture"]]);
  assert.deepEqual(stdout, ["SHOT path=review.png bytes=11\n"]);
  assert.deepEqual(stderr, []);
});

test("shot adapter does not publish missing or failed image data", async () => {
  for (const response of [
    { failed: true, text: "backend failed" },
    { data: {} },
  ]) {
    const writes = [],
      errors = [];
    const code = await shotCmd(
      { callTool: async () => response },
      [],
      {
        stdout: { write() {} },
        stderr: { write: (text) => errors.push(text) },
      },
      { writeFileSync: (...args) => writes.push(args) },
      () => 1,
    );
    assert.equal(code, 1);
    assert.deepEqual(writes, []);
    assert.equal(errors.length, 1);
  }
});
