"use strict";

// Compatibility launcher. The MCP composition root is TypeScript and must be
// emitted by build:code; consumers never execute or resolve source TypeScript.
const path = require("node:path");
const runtime = path.join(__dirname, "dist/entrypoints/mcp-stdio.js");
const mcp = require(runtime);

module.exports = mcp;

if (require.main === module) mcp.startStdio(process.argv.slice(2));
