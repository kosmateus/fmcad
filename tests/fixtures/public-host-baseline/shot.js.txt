"use strict";
const fs = require("node:fs");

function findBase64(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.base64Data) return value.base64Data;
  if (value.data) return value.data;
  if (value.result && value.result.base64Data) return value.result.base64Data;
  const content = value.content || (value.result && value.result.content);
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "image" && item.data) return item.data;
      if (item.base64Data) return item.base64Data;
    }
  }
  return null;
}

/** Dedicated legacy command adapter. docops.js wiring is owned by sol-documents. */
async function shotCmd(client, args, io = process, files = fs, now = Date.now) {
  let outFile = null;
  const callArgs = { queryType: "screenshot" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") outFile = args[++i];
    else if (arg === "--dir") callArgs.direction = args[++i];
    else if (arg === "--width") callArgs.width = Number(args[++i]);
    else if (arg === "--height") callArgs.height = Number(args[++i]);
    else if (arg === "--no-aa") callArgs.antiAliasing = false;
    else if (arg === "--transparent") callArgs.transparentBackground = true;
  }
  const output = await client.callTool(callArgs, "fusion_mcp_read");
  const base64 =
    findBase64(JSON.stringify(output.data || {})) || findBase64(output.text);
  if (output.failed) {
    io.stderr.write("ERROR screenshot failed: " + output.text + "\n");
    return 1;
  }
  if (!base64) {
    io.stderr.write("ERROR no image data in screenshot response\n");
    return 1;
  }
  const file = outFile || `shot-${now()}.png`;
  const bytes = Buffer.from(base64, "base64");
  files.writeFileSync(file, bytes);
  io.stdout.write(`SHOT path=${file} bytes=${bytes.length}\n`);
  return 0;
}

module.exports = { shotCmd, findBase64 };
