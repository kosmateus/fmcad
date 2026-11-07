import * as fs from "node:fs";
import path from "node:path";

/** Remove orphan .ts emissions only, preserving outputs owned by other builds. */
export function pruneTypeScriptEmissions(
  source: string,
  outputs: readonly string[],
): void {
  if (!fs.statSync(source).isDirectory())
    throw new Error("Missing TypeScript source directory: " + source);
  for (const output of outputs) {
    if (!fs.existsSync(output)) continue;
    visit(output);
    function visit(directory: string): void {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (
          entry.isFile() &&
          /(?:\.d\.ts|\.js)(?:\.map)?$/.test(entry.name)
        ) {
          const original = path.join(
            source,
            path
              .relative(output, file)
              .replace(/(?:\.d\.ts|\.js)(?:\.map)?$/, ".ts"),
          );
          if (!fs.existsSync(original)) fs.rmSync(file);
        }
      }
    }
  }
}
