import assert from "node:assert/strict";
import { cadCommand } from "./cad-programs";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list } from "../integration/offline-cli";
export const g30_6 = {
  id: "G30-06",
  title:
    "gm30: G30-06 visibility.finalize composes hide/recompute and leaves the requested state",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    await fmcad([
      "sketch",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({ name: "G30Sketch", plane: "XY" }),
    ]);
    const out = await fmcad([
      "visibility",
      "finalize",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        hide: ["G30Sketch"],
        recompute: true,
        checkHealth: true,
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "leftRequestedState"), true);
    assert.equal(at(out, "result", "recomputed"), true);
    assert.ok(
      list(at(out, "result", "hidden")).some(
        (ref) => at(ref, "name") === "G30Sketch",
      ),
    );
  },
};
export const g30_8 = {
  id: "G30-08",
  title:
    "gm30: G30-08 visibility.finalize reports a healthy timeline through checkHealth",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    await fmcad([
      "sketch",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({ name: "G30Sketch", plane: "XY" }),
    ]);
    const out = await fmcad([
      "visibility",
      "finalize",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        hide: ["G30Sketch"],
        recompute: true,
        checkHealth: true,
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "health", "available"), true);
    assert.deepEqual(at(out, "result", "health", "unhealthy"), []);
  },
};
export const g30_5 = {
  id: "G30-05",
  title: "G30-05 camera orientation cannot be combined with eye",
  async run(session: ScenarioSession) {
    const out = await session.execute(
      "camera-conflict",
      cadCommand(session.document, "camera.set", {
        orientation: "front",
        eye: ["1 cm", "2 cm", "3 cm"],
      }),
      session.document,
      "cad-v1",
    );
    assert.ok(
      String(out["error"]).includes("orientation cannot be combined"),
      String(out["error"]),
    );
    assert.equal(out["result"], null);
  },
};
export const gm30Cases = [g30_5, g30_6, g30_8];
