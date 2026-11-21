import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Document, FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
import { emit, guard } from "./programs";

export const nativeParameterTestCapability =
  "native-parameter-test-local-restore";
export const nativeParameterFixtures = [
  {
    source: "tests/native/iw7.4_parameter_test.py",
    sha256: "9f777a3a6235d75c9568650fa197d8704a9c6a3cc9e3ea8eb55c195a7a13b0f5",
  },
  {
    source: "tests/native/iw7.4_parameter_failures.py",
    sha256: "9389aa6f1ba70ee39d21db21a0f4af2bbcfba6d6d803f5564b0eafe85f29d2de",
  },
] as const;

/** The reviewed Python body is unchanged; only its documented ARGS slot is bound. */
export function nativeParameterProgram(
  document: Document,
  fixture: (typeof nativeParameterFixtures)[number],
): string {
  if (!document.file)
    throw new Error("Native parameter fixture requires its owned saved file");
  const root = path.resolve(__dirname, "../../..");
  const source = fs.readFileSync(path.join(root, fixture.source), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== fixture.sha256)
    throw new Error(
      "Retained parameter acceptance source changed after review",
    );
  if ((source.match(/^ARGS = \{\}$/gmu) ?? []).length !== 1)
    throw new Error(
      "Retained parameter source requires exactly one documented ARGS slot",
    );
  const args = {
    fileId: document.file.fileId,
    projectId: document.file.projectId,
    folderId: document.file.folderId,
  };
  return (
    source.replace(/^ARGS = \{\}$/mu, () => "ARGS = " + JSON.stringify(args)) +
    `
_retained_parameter_run = run
def run(context):
${guard(document)
  .split("\n")
  .map((line) => "    " + line)
  .join("\n")}
    result = _retained_parameter_run(context)
    ${emit(`dict(creationId=${JSON.stringify(document.creationId)}, result=result)`)}
`
  );
}

/** Native-only: both retained phases share one newly owned saved scratch Design. */
export function nativeParameterTestScenarios(
  folder: FixtureFolder,
  owners = 10,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-parameter-test-" + index,
    fixture: folder,
    scope: "exclusive-instance",
    requires: ["documents", "saved-fixtures", nativeParameterTestCapability],
    async run(session) {
      for (const [phase, fixture] of nativeParameterFixtures.entries()) {
        try {
          await session.execute(
            "native-parameter-test-" + phase,
            nativeParameterProgram(session.document, fixture),
            session.document,
            "cad-v1",
          );
        } catch (cause) {
          // require_pass can throw after a failed local restore. Retain the
          // original fixture and request evidence instead of assuming rollback.
          session.deferCleanup(
            "Original parameter-test phase did not prove native local restoration: " +
              String(cause),
          );
        }
      }
    },
  }));
}
