import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests/python-aggregate-failure.test.js"),
);
const { createPythonChecker } = load(
  "../packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { preparePythonArtifact } = load(
  "../packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");

// Same two-body projection fixture and recording engine as the retained
// completeness suite. The actual inventory/projection executes; no SDK exists.
for (const mode of [
  "aborted-later-preparation",
  "changed-engine-identity",
] as const) {
  test(
    "aggregate refusal retains its root cause and provenance fence: " + mode,
    { timeout: 45000 },
    async (t) => {
      const temporary = await fs.mkdtemp(
        path.join(os.tmpdir(), "aggregate-failure-cause-"),
      );
      t.after(() => fs.rm(temporary, { recursive: true, force: true }));
      const evidence = path.join(temporary, "engine.jsonl");
      const engine = path.join(temporary, "recording-checker.cjs");
      const template = await fs.readFile(
        path.join(
          repository,
          "tests/fixtures/python-checker-completeness/recording-checker.cjs",
        ),
        "utf8",
      );
      await fs.writeFile(
        engine,
        template
          .replace("__MODE__", JSON.stringify("pass"))
          .replace("__EVIDENCE_PATH__", JSON.stringify(evidence)),
      );
      const artifact = preparePythonArtifact(
        ["alpha", "beta"].map((name) => ({
          id: name + "-runtime",
          filename: name + "-runtime.py",
          role: "runtime" as const,
          source: `def ${name}() -> list[int]:\n    return [${Array<string>(40020).fill("0").join(",")}]\n`,
        })),
      );
      let identities = 0;
      const abort = new AbortController();
      const checker = createPythonChecker({
        typingRoot: path.join(repository, "runtime/python/typing"),
        temporaryRoot: temporary,
        engineEntrypoint: engine,
        limits: { timeoutMs: 5000, outputBytes: 2 * 1024 * 1024 },
        checkerResources: () => {
          identities++;
          if (identities === 2 && mode === "aborted-later-preparation") {
            abort.abort();
            throw new Error(
              "aborted later preparation before checker identity",
            );
          }
          return (
            identities === 2 && mode === "changed-engine-identity" ? "b" : "a"
          ).repeat(64);
        },
      });
      const report = await checker.check(
        { artifact, context: { kind: "raw" } },
        { signal: abort.signal },
      );
      assert.equal(
        report.status,
        "tool_error",
        "Partial or different provenance never becomes a certificate",
      );
      assert.ok(
        report.reasons.includes(
          "Aggregate checker provenance changed between analysis passes",
        ),
      );
      if (mode === "aborted-later-preparation") {
        assert.match(
          report.reasons.join("\n"),
          /aborted/,
          "The aggregate must retain the actual aborted preparation cause",
        );
        assert.equal(
          identities,
          2,
          "The second preparation reaches the aborting identity producer",
        );
      } else {
        assert.equal(
          identities,
          2,
          "Both engine identities were actually observed",
        );
        assert.doesNotMatch(report.reasons.join("\n"), /aborted/);
      }
      assert.deepEqual(
        report.diagnostics,
        [],
        "Incomplete passes do not publish a partial result as complete diagnostics",
      );
    },
  );
}
