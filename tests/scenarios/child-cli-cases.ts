import type { FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
export function childCliScenarios(
  folder: FixtureFolder,
  owners = 10,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "child-cli-" + index,
    fixture: folder,
    requires: ["documents", "saved-fixtures", "owned-child-cli"],
    run: (session) =>
      session.legacyCli(
        "tests/fixtures/owned-cli/handoff.test.js",
        "owned child CLI preserves original receipts",
      ),
  }));
}
