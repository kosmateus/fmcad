import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { record, type Fields } from "../integration/offline-cli";

/** Historical GM command inputs, executed by the existing owned CAD path.
 * This port exposes envelopes only: a component result is not a process exit.
 */
export function gmCommands(session: ScenarioSession) {
  let sequence = 0;
  const command = async (args: string[]): Promise<Fields> => {
    const doc = args.indexOf("--doc");
    const data = args.indexOf("--data");
    assert.ok(doc > 0 && data > doc);
    assert.equal(args[doc + 1], session.document.name);
    const payload: unknown = JSON.parse(args[data + 1]!);
    const operation = args.slice(0, doc).join(".");
    return session.cad(
      "cad-gm-" + sequence++ + "-" + operation,
      operation,
      record(payload),
    );
  };
  return {
    async fmcad(args: string[]): Promise<Fields> {
      const output = await command(args);
      assert.equal(output["success"], true, JSON.stringify(output));
      return output;
    },
    async cad(args: string[]) {
      return { json: await command(args) };
    },
    async cli(args: string[]) {
      return { out: await command(args) };
    },
  };
}
