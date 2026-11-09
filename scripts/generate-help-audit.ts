import * as fs from "node:fs";
import path from "node:path";
import { commands } from "../src/dist/composition/library-commands";
import { manuals } from "../src/dist/composition/library-help-manual";
import { detail } from "../src/dist/composition/library-help";

// Emitting reference files is separate from qualifying the unfinished audits.
// The normal invocation and --check retain their existing failing audit status.
const writeOnly = process.argv.includes("--write-only");
if (writeOnly && process.argv.includes("--check"))
  throw new Error("--write-only cannot be combined with --check");

const cell = (value: unknown): string =>
  String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
const rows = commands.map((command) => {
  const family = command.kind === "family";
  const manualKey = command.kind === "cad" ? command.target : command.key;
  const manual = family || manualKey === undefined ? null : manuals[manualKey];
  const audit =
    manual?.audit ||
    (family
      ? {
          sources: [
            "src/commands.js:family registration",
            "src/help-manual.js:manualHelp",
          ],
          verified: [
            "group is non-executable",
            "actual canonical/alias child discovery",
            "offline detailed help routing",
          ],
          tests: ["tests/registry.test.js", "tests/manual-coverage.test.js"],
          gaps: [],
          bugs: [],
        }
      : {
          sources: [],
          verified: [],
          tests: [],
          gaps: ["MISSING MANUAL"],
          bugs: [],
        });
  return { command, manual, audit };
});
const missing = rows.filter((row) => row.audit.gaps.length);
const aliases = commands.flatMap((command) =>
  (command.aliases || []).map((alias) => ({ alias, canonical: command.key })),
);
const bugRows = rows.flatMap(({ command, audit }) =>
  audit.bugs.map((bug) => `| ${cell(command.key)} | ${cell(bug)} |`),
);
let coverage =
  `# Command Documentation Coverage\n\n` +
  `Source-contract audit: ${commands.length} registered canonical routes (${commands.filter((c) => c.kind === "cad").length} CAD, ${commands.filter((c) => !["cad", "family"].includes(c.kind)).length} legacy/help, ${commands.filter((c) => c.kind === "family").length} groups), ${aliases.length} alias spellings. The secondary bin/fmcad-mcp.js entry point is documented in the shared CLI guide.\n\n` +
  `Unfinished command audits: ${missing.length}. This number is based on per-command source-audit records, not outer catalog-schema validation. Source audit covers all branches identified by the assigned reviewers; offline tests cannot certify Fusion solver/kernel behavior, live cloud durability, installed raw-tool schemas or every real entity type. Known defects below are documented usage limitations, not silently fixed.\n\n` +
  `User-facing reference: [COMMAND_REFERENCE.md](COMMAND_REFERENCE.md), or fmcad help <command>. Shared flags/config/backends: fmcad help help. Documentation-only workflow exercises and precise test boundaries: [DOCUMENTATION_USABILITY.md](DOCUMENTATION_USABILITY.md).\n\n` +
  `Regenerate/check with node scripts/generate-help-audit.js [--check]. This file inventories every registry route; aliases have the same contract as their canonical owner. Tests listed are evidence files, not a claim that every SDK geometry branch runs offline.\n\n` +
  `| Command | Handler/source audit | Verified aspects | Supplemental examples | Test evidence | Unfinished gaps |\n| --- | --- | --- | --- | --- | --- |\n`;
for (const { command, manual, audit } of rows)
  coverage += `| ${cell(command.key)} | ${cell(audit.sources.join("; "))} | ${cell(audit.verified.join("; "))} | ${manual?.examples?.length || 0} | ${cell(audit.tests.join("; ") || ("testRetirementReason" in audit ? String(audit.testRetirementReason) : "None"))} | ${cell(audit.gaps.join("; ") || "None (live execution not certified)")} |\n`;
coverage +=
  "\n## Secondary Entry Point\n\n| Entry | Verified contract | Evidence | Gaps |\n| --- | --- | --- | --- |\n| node bin/fmcad-mcp.js | local catalog tools/list, shared typed CAD execution, phased broker admission, owned artifact reads, raw forwarding/session/errors without sandbox/fallback/retry | src/mcp-stdio.js; tests/mcp-catalog.test.js; tests/catalog-worker.test.js; tests/mcp-stdio.test.js; fmcad help help | Offline tests do not certify live Fusion or cloud permission; installed raw schemas require fmcad tools --json |\n";
coverage +=
  "\n## Aliases\n\n| Accepted spelling | Canonical help |\n| --- | --- |\n" +
  aliases
    .map(({ alias, canonical }) => `| ${cell(alias)} | ${cell(canonical)} |`)
    .join("\n") +
  "\n";
coverage +=
  "\n## Shared CAD Catalog Projection\n\nGenerated from `core/catalog` contracts used by CLI/help and local MCP tools/list. This table does not assert live transport availability, backend permissions, geometry validity or read-only enforcement. Nested validation remains in the shared specialist chain and SDK handlers, not prose-derived schemas.\n\n" +
  "| Operation | CLI | Service | SDK | Cloud | Document | Read-only requested | Read-only enforced |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n" +
  commands
    .filter((command) => command.contract)
    .map((command) => {
      const contract = command.contract;
      if (!contract) throw new Error("Missing filtered operation contract");
      return `| ${cell(contract.operation)} | ${cell(command.key)} | ${cell(contract.service.kind + ":" + contract.service.handler)} | ${contract.requirements.sdk} | ${contract.requirements.cloud} | ${contract.requirements.document ? "required" : "optional"} | ${contract.readOnlyRequested} | ${contract.readOnlyEnforced} |`;
    })
    .join("\n") +
  "\n";
coverage +=
  "\n## Known Implementation Defects And Caveats\n\nThese are exposed in detailed help. Queue and Fusion lifecycle operations are separate from the CAD modeling catalog; their execution does not imply model or physical validation.\n\n| Command | Caveat / defect |\n| --- | --- |\n" +
  (bugRows.join("\n") || "| None | None recorded |") +
  "\n";

let reference =
  "# fmcad Command Reference\n\nGenerated from the same bundled manuals used by detailed CLI help. Installation-specific package paths are shown as <package>; live help resolves them for the current installation. No source-code access is needed to use this reference. Read prerequisites before executing any example; token/name/library examples require actual discovery. JSON payloads are not promises of live kernel feasibility.\n\n";
for (const command of commands)
  reference += `## ${command.key}\n\n\`\`\`text\n${detail(
    command.key.split(" ")[0] ?? "",
    ...command.key.split(" ").slice(1),
  )
    .replaceAll(path.resolve(__dirname, ".."), "<package>")
    .replaceAll("```", "~~~")}\`\`\`\n\n`;
for (const [name, content] of [
  ["COMMAND_COVERAGE.md", coverage],
  ["COMMAND_REFERENCE.md", reference],
] as const) {
  const file = path.join(__dirname, "..", "docs", name);
  if (process.argv.includes("--check")) {
    if (
      !fs.existsSync(file) ||
      fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n") !== content
    )
      throw new Error("Stale generated documentation: " + name);
  } else fs.writeFileSync(file, content);
}
console.log(
  `${commands.length} routes, ${aliases.length} aliases, ${missing.length} unfinished audits; generated documentation ${process.argv.includes("--check") ? "current" : "written"}.`,
);
if (missing.length && !writeOnly) process.exitCode = 1;
