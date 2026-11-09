import assert from "node:assert/strict";
import { record, type FixtureFolder } from "./contracts";
import { cadCommand } from "./cad-programs";
import type { Scenario } from "./runner";
import { cases as thread } from "./gm13-thread-declarations";
import { cases as seal } from "./gm15-seal-declarations";
import { cases as fasteners } from "./gm16-fasteners-declarations";
import { cases as mechanism } from "./gm17-mechanism-declarations";
import { cases as pose } from "./gm18-pose-declarations";
import { cases as interference } from "./gm19-interference-declarations";
import { cases as containment } from "./gm20-containment-declarations";
export interface DeclarationCase {
  readonly id: string;
  run(
    cad: (
      operation: string,
      data: Record<string, unknown>,
      expectedFailure?: boolean,
    ) => Promise<Record<string, unknown>>,
  ): Promise<void>;
}
export const retainedDeclarations = {
  thread,
  seal,
  fasteners,
  mechanism,
  pose,
  interference,
  containment,
} as const;
export type DeclarationFamily = keyof typeof retainedDeclarations;
/** Original declaration values/assertions in fresh owned unsaved documents. No save/reopen qualification is inferred. */
export function retainedDeclarationScenarios(
  _folder: FixtureFolder,
  family: DeclarationFamily,
  owners = 2,
): Scenario[] {
  return retainedDeclarations[family].flatMap((entry) =>
    Array.from({ length: owners }, (_, index): Scenario => ({
      id: "retained-" + family + "-" + entry.id + "-" + index,
      requires: ["documents", "retained-declarations"],
      async run(session) {
        let sequence = 0;
        {
          const cad = async (
            operation: string,
            data: Record<string, unknown>,
            expectedFailure = false,
          ) => {
            const output = await session.execute(
              "retained-" + entry.id + "-" + sequence++,
              cadCommand(session.document, operation, data),
              session.document,
              "cad-v1",
            );
            if (output["error"] !== null)
              throw new Error(String(output["error"]));
            const result = record(output["result"]);
            assert.equal(result["operation"], operation);
            if (
              result["success"] === false &&
              !expectedFailure &&
              !(
                operation === "clearance.grid" && result["status"] === "unknown"
              )
            )
              throw new Error(JSON.stringify(result));
            return result;
          };
          await entry.run(cad);
        }
      },
    })),
  );
}
