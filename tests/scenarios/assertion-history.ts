import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertionSites, currentSources, digest } from "./assertion-inventory";

export function compareAssertionSources(
  beforePath: string,
  before: string,
  afterPath: string,
  after: string,
) {
  const earlier = assertionSites(beforePath, before);
  const later = assertionSites(afterPath, after);
  const beforeIds = new Set(earlier.map((site) => site.id));
  const afterIds = new Set(later.map((site) => site.id));
  return {
    before: {
      source: beforePath,
      sha256: digest(before),
      count: earlier.length,
    },
    after: { source: afterPath, sha256: digest(after), count: later.length },
    retainedIds: earlier
      .filter((site) => afterIds.has(site.id))
      .map((site) => site.id),
    removed: earlier.filter((site) => !afterIds.has(site.id)),
    addedIds: later
      .filter((site) => !beforeIds.has(site.id))
      .map((site) => site.id),
  };
}

// These ports retained/replaced old JS sources rather than Git-detected renames.
// Resolve the explicit predecessor path before calling a source newly introduced.
const predecessorPaths: Readonly<Record<string, string>> = {
  "tests/live-data-import.ts": "tests/live-data-import.js",
  "tests/live-data-import-fixed.ts": "tests/live-data-import-fixed.js",
  "tests/live-sketch-operations.ts": "tests/live-sketch-operations.js",
};
export function auditLatestPredecessors(root: string, archiveGit: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir=" + archiveGit, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const read = (commit: string, source: string): string | undefined => {
    // Missing paths are different from corrupt/unreadable Git object failures.
    const files = git("ls-tree", "--name-only", commit, "--", source).trim();
    return files ? git("show", commit + ":" + source) : undefined;
  };
  return currentSources(root).map((source) => {
    const current = fs.readFileSync(path.join(root, source), "utf8");
    const candidates = git("log", "--all", "--format=%H", "--", source)
      .trim()
      .split("\n")
      .filter(Boolean);
    const commit = candidates.find(
      (candidate) => read(candidate, source) === current,
    );
    if (!commit) throw new Error("No exact archived source match: " + source);
    const parent = git("rev-list", "--parents", "-n", "1", commit)
      .trim()
      .split(" ")[1];
    if (!parent) throw new Error("Source commit has no predecessor: " + source);
    let beforePath = source;
    let before = read(parent, source);
    if (before === undefined && predecessorPaths[source]) {
      beforePath = predecessorPaths[source]!;
      before = read(parent, beforePath);
      if (before === undefined)
        throw new Error("Missing declared port predecessor: " + beforePath);
    }
    return {
      source,
      commit,
      predecessor: parent,
      introduced: before === undefined,
      comparison: compareAssertionSources(
        beforePath,
        before ?? "",
        source,
        current,
      ),
    };
  });
}

if (require.main === module) {
  const [archiveGit, output] = process.argv.slice(2);
  if (!archiveGit || !output)
    throw new Error("Usage: assertion-history ARCHIVE_GIT OUTPUT_JSON");
  const root = path.resolve(__dirname, "../../..");
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        scope:
          "Latest exact archived source and its first parent, including explicit JS port predecessors; not all earlier changes or semantic equivalence.",
        sources: auditLatestPredecessors(root, path.resolve(archiveGit)),
      },
      null,
      2,
    ) + "\n",
  );
}
