import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { commands, type RegisteredCommand } from "./library-commands";
const load = createRequire(__filename);
export interface CommandManual {
  sections: { title: string; text: string }[];
  examples?: {
    label: string;
    requires: string;
    output: string;
    argv?: string[];
    data?: Record<string, unknown>;
  }[];
  audit: {
    sources: string[];
    verified: string[];
    tests: string[];
    gaps: string[];
    bugs: string[];
  };
}
function provider(name: string): {
  manuals: Record<string, CommandManual>;
  manual: CommandManual;
} {
  return load("../../" + name);
}
const { manuals: legacy } = provider("legacy-manual");
export const manuals: Record<string, CommandManual> = {
  ...legacy,
  ...provider("reference").manuals,
  ...provider("drawing-package").manuals,
  ...provider("fusion-reset").manuals,
  ...provider("broker-manual").manuals,
  ...provider("data-import").manuals,
  ...provider("surface").manuals,
  ...provider("datum").manuals,
  ...provider("engineering-local").manuals,
  review: provider("review").manual,
  help: load("../../help-guide") as CommandManual,
  "image trace": provider("image-trace").manual,
  "image optimize": provider("image-optimize").manual,
  "image boundaries": provider("image-boundaries").manual,
};
for (const file of fs
  .readdirSync(path.join(__dirname, "../../manual"))
  .sort()) {
  if (!file.endsWith(".json")) continue;
  for (const [key, value] of Object.entries(
    load("../../manual/" + file) as Record<string, CommandManual>,
  )) {
    if (manuals[key]) throw new Error("Duplicate command manual: " + key);
    manuals[key] = value;
  }
}
const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";
export function manualHelp(entry: RegisteredCommand): string {
  if (entry.kind === "family") {
    const children = commands.filter(
      (c) =>
        c.kind !== "family" &&
        (c.key.startsWith(entry.key + " ") ||
          (c.kind === "cad" && c.target!.startsWith(entry.key + ".")) ||
          (c.aliases || []).some((alias) => alias.startsWith(entry.key + " "))),
    );
    const warning =
      entry.key === "export"
        ? "\nLegacy export --out requires an absolute WSL path, preferably /mnt/c/...; explicit relative/Windows-native paths are mis-mapped and existing outputs are unguarded. Use cad export step or export mesh for their separate scoped/path/overwrite contracts.\n"
        : "";
    return (
      warning +
      "\nGroup Commands (no operation is executed by the group name):\n" +
      children
        .map((c) => `  fmcad help ${c.key} - ${c.description}`)
        .join("\n") +
      "\nChoose an exact command above. Shared flags, config/backends and parsing: fmcad help help.\n"
    );
  }
  const manual = manuals[entry.kind === "cad" ? entry.target! : entry.key];
  if (!manual)
    return "\nShared flags, config/backends and parsing: fmcad help help.\n";
  let text =
    "\n" +
    manual.sections.map((s) => `${s.title}:\n${s.text}`).join("\n\n") +
    "\n";
  for (const example of manual.examples || []) {
    text += `\nWorked Example: ${example.label}\nPrerequisites: ${example.requires}\n`;
    if (example.argv)
      text += "  fmcad " + example.argv.map(shellQuote).join(" ") + "\n";
    else if (example.data) {
      const batchOnly = /"\$(ref|param)"\s*:/.test(
        JSON.stringify(example.data),
      );
      if (batchOnly) {
        text +=
          "Batch-step example, NOT a standalone --data payload. Append after the earlier steps described above; use a unique step id and the intended component scope.\n";
        text +=
          "```json\n" +
          JSON.stringify(
            { id: "example", operation: entry.target, data: example.data },
            null,
            2,
          ) +
          "\n```\n";
        text +=
          "Place this step in an operations array with runId; see fmcad help batch run for complete file syntax. For a standalone call substitute actual returned JSON values first, removing $ref/$param markers.\n";
      } else {
        text += "```json\n" + JSON.stringify(example.data, null, 2) + "\n```\n";
        text += `  fmcad ${entry.key}${entry.requiresDoc ? " --doc Model" : ""}${entry.target === "document.clear" ? " --doc-file-id " + shellQuote(example.data["fileId"] as string) : ""} --data ${shellQuote(JSON.stringify(example.data))}\n`;
      }
    }
    text += "Expected output: " + example.output + "\n";
  }
  if (entry.target === "batch.run") {
    text +=
      "\nConcise Output:\n--summary is a boolean formatting flag accepted only by batch run. It prints TEXT status/runId/reportPath and per-step id/status/error, explicitly as historical reported outcomes, not current model validation. --json takes precedence and returns the full unchanged JSON report. Formatting never enters execution context/requestHash or changes saved snapshots/reference outputs. Use batch summary --report-path DIR [--step N] [--json] for later local inspection; step numbers are 1-based.\n";
    const workflow = load("../../help-workflow-example.json") as unknown;
    text +=
      "\nWorked Workflow: Multi-component parametric sketch-to-solid\n" +
      "Prerequisites: a uniquely named open Model; no DocRoundPart/DocBoxPart or helper-name collisions; width/depth/height must be absent or already identical numeric user parameters. Parametric design at timeline end, no pending positions, idle command. Fresh local report directory or exact successful replay.\n" +
      "This payload creates two component definitions and instances. Every modeling step explicitly chooses its intended component; omission never inherits the previous step. Box placement is a numeric snapshot, not a parameter equation.\n" +
      "The circle radius initializes at 10 mm, then a real driving diameter uses the Fusion parameter width. Its center starts at [10,10] mm and is constrained to the explicitly created fixed point at [5,5] mm, not a guessed origin token. These center coordinates are numeric initialization/fixation, not parameter equations. Extrusion uses height. The box recipe retains its own width/depth/height dimensions.\n" +
      "```json\n" +
      JSON.stringify(workflow, null, 2) +
      "\n```\n" +
      "Use fmcad batch validate --doc Model --file workflow.json, then batch preview with the same arguments. Only an explicit batch run executes it. For literal definition expansion, definition instantiate --preview accepts the same payload.\n" +
      "Actual outputs: roundPart.result.component and boxPart.result.component set scope; section.result.sketch is reused; geometry.result.refs.anchor/rim feed the constraint/dimension; boxSolid.result.bodies.0 is discovered from its actual output. Inspect roundCheck.output.result.isFullyConstrained and profileCount in the returned report, not an assumed solver result.\n" +
      'To test a retained equation after successful creation, explicitly run param apply --doc Model --data \'{"parameters":[{"name":"width","expression":"50 mm"}],"overwrite":true}\', then history recompute and fresh sketch check/measurements. Do not edit and replay the original batch as a parameter-update mechanism. Solver feasibility and regeneration remain live-only verification; this documented recipe is tested through offline validation and mock output wiring, not executed by help.\n';
  }
  if (["batch.run", "batch.summary"].includes(entry.target!)) {
    text +=
      "\nSummary result selection:\nThe fixed small-result allowlist is value, units, count, healthy, healthState, passed, sampledPassed and checkOutcome. Only present scalar/null values are copied (strings up to 256 characters); geometry, refs and metadata remain in the full report. Missing fields are not reported as zero. Errors remain explicit.\n";
    if (entry.target === "batch.summary")
      text +=
        "--preview only validates outer input fields; it does not read or validate report history.\n";
  }
  if (manual.audit.bugs.length)
    text +=
      "\nKnown Implementation Caveats:\n" +
      manual.audit.bugs.map((b) => "  - " + b).join("\n") +
      "\n";
  if (manual.audit.gaps.length)
    text +=
      "\nUnfinished Documentation Verification:\n" +
      manual.audit.gaps.map((g) => "  - " + g).join("\n") +
      "\n";
  if (entry.key !== "help")
    text += "\nShared flags, config/backends and parsing: fmcad help help.\n";
  return text;
}
