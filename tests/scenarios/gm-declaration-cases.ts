import type { FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
import { gm25Cases } from "./gm25-cases";
import { gm26Cases } from "./gm26-cases";
import { gm27Cases } from "./gm27-cases";
import { gm28Cases } from "./gm28-cases";
import { gm29Cases } from "./gm29-cases";
import { gm30Cases } from "./gm30-cases";
import { gm31Cases } from "./gm31-cases";
import { gm32Cases } from "./gm32-cases";
import { gm34Cases } from "./gm34-cases";
import { gm36Cases } from "./gm36-cases";
import { gm37Cases } from "./gm37-cases";

export const gmDeclarationCases = [
  ...gm25Cases,
  ...gm26Cases,
  ...gm27Cases,
  ...gm28Cases,
  ...gm29Cases,
  ...gm30Cases,
  ...gm31Cases,
  ...gm32Cases,
  ...gm34Cases,
  ...gm36Cases,
  ...gm37Cases,
];

/** The same historical inputs and assertions run against either owned backend. */
export function gmDeclarationScenarios(
  folder: FixtureFolder,
  owners = 1,
): Scenario[] {
  return Array.from({ length: owners }, (_, owner) =>
    gmDeclarationCases.map((item): Scenario => ({
      id: "gm-contract-" + item.id.toLowerCase() + "-" + owner,
      fixture: folder,
      requires: ["documents", "saved-fixtures"],
      scope: item.id.startsWith("G30-")
        ? "exclusive-instance"
        : "owned-document",
      run: item.run,
    })),
  ).flat();
}
