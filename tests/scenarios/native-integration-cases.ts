import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
export const nativeIntegrationCapability = "native-owned-integration-cli";
interface NativeCase {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly sourceSha256: string;
}
export function nativeIntegrationScenarios(
  folder: FixtureFolder,
  owners = 1,
): Scenario[] {
  const root = path.resolve(__dirname, "../../..");
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/scenarios/native-integration-cases.json"),
      "utf8",
    ),
  ) as { cases: NativeCase[] };
  return manifest.cases.flatMap((entry) =>
    Array.from({ length: owners }, (_, index): Scenario => ({
      id: "native-integration-" + entry.id + "-" + index,
      fixture: folder,
      requires: ["documents", "saved-fixtures", nativeIntegrationCapability],
      // Retained native cases include viewport/presentation and timeline-global work.
      // Per-case exclusive barriers preserve old global assumptions until narrowed by evidence.
      scope: "exclusive-instance",
      async run(session) {
        const bytes = fs.readFileSync(path.join(root, entry.source));
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          entry.sourceSha256
        )
          throw new Error(
            "Retained native integration source changed after assertion review",
          );
        await session.legacyCli(entry.source, entry.title);
      },
    })),
  );
}
