"use strict";

const fs = require("node:fs");
const path = require("node:path");

const mode = __MODE__;
const evidencePath = __EVIDENCE_PATH__;
const projectArgument = process.argv.indexOf("--project");
if (projectArgument < 0 || !process.argv[projectArgument + 1]) process.exit(2);

const projectPath = process.argv[projectArgument + 1];
const projectRoot = path.dirname(projectPath);
const config = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const files = config.include.map((name) => ({
  name,
  path: path.resolve(projectRoot, name),
  source: fs.readFileSync(path.resolve(projectRoot, name), "utf8"),
}));
const sources = files.map((file) => file.source);
const combined = sources.join("\n");
const previous = fs.existsSync(evidencePath)
  ? fs.readFileSync(evidencePath, "utf8").trim().split("\n").filter(Boolean)
  : [];
const call = previous.length + 1;
const evidence = {
  call,
  files: files.map(({ name, source }) => ({
    name,
    bytes: Buffer.byteLength(source),
  })),
  alphaActive: /\bdef alpha\b[^\n]*\n[ \t]*return\b/.test(combined),
  alphaProjected: /\bdef alpha\b[^\n]*\n[ \t]*raise NotImplementedError\b/.test(
    combined,
  ),
  betaActive: /\bdef beta\b[^\n]*\n[ \t]*return\b/.test(combined),
  betaProjected: /\bdef beta\b[^\n]*\n[ \t]*raise NotImplementedError\b/.test(
    combined,
  ),
  functionHeaders: combined.match(/\bdef (?:alpha|beta)\b[^\n]*/g),
  projectedBodies: (combined.match(/\braise NotImplementedError\b/g) ?? [])
    .length,
};
fs.appendFileSync(evidencePath, JSON.stringify(evidence) + "\n");

if (call === 2 && mode === "oom-second") process.exit(137);
if (call === 2 && mode === "timeout-second") {
  setInterval(() => {}, 1000);
  return;
}
if (call === 2 && mode === "missing-second") {
  process.stdout.write('{"version":"1.40.2"');
  return;
}

const diagnostics = [];
const addMarkerDiagnostic = (marker) => {
  if (mode === "incomplete-beta" && marker.includes("ALPHA")) return;
  for (const file of files) {
    const position = file.source.indexOf(marker);
    if (position < 0) continue;
    const before = file.source.slice(0, position);
    diagnostics.push({
      file: file.path,
      severity: "error",
      message: "Synthetic checker fixture return type mismatch",
      rule:
        mode === "incomplete-beta" && marker.includes("BETA")
          ? "reportAny"
          : "reportReturnType",
      range: {
        start: {
          line: before.split("\n").length - 1,
          character: position - before.lastIndexOf("\n") - 1,
        },
        end: { line: before.split("\n").length - 1, character: 1 },
      },
    });
  }
};

addMarkerDiagnostic("__TYPE_ERROR_ALPHA__");
addMarkerDiagnostic("__TYPE_ERROR_BETA__");
if (call === 2 && mode === "incomplete-second") {
  diagnostics.push({
    file: files[0]?.path ?? projectPath,
    severity: "error",
    message: "Synthetic incomplete typing result",
    rule: "reportAny",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  });
}

const filesAnalyzed =
  call === 2 && mode === "partial-second"
    ? Math.max(0, files.length - 1)
    : files.length;
process.stdout.write(
  JSON.stringify({
    version: "1.40.2",
    summary: { filesAnalyzed, errorCount: diagnostics.length },
    generalDiagnostics: diagnostics,
  }),
);
process.exit(diagnostics.length ? 1 : 0);
