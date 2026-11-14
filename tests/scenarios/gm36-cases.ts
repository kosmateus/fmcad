import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cadCommand } from "./cad-programs";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, number, record } from "../integration/offline-cli";
// Create two root child components and return their occurrence refs.
async function twoOccurrences(session: ScenarioSession, a: string, b: string) {
  const { fmcad } = gmCommands(session);
  const doc = session.document.name;
  const cover = await fmcad([
    "component",
    "create",
    "--doc",
    doc,
    "--data",
    JSON.stringify({ name: a }),
  ]);
  const pcb = await fmcad([
    "component",
    "create",
    "--doc",
    doc,
    "--data",
    JSON.stringify({ name: b }),
  ]);
  assert.equal(at(cover, "success"), true, JSON.stringify(cover));
  assert.equal(at(pcb, "success"), true, JSON.stringify(pcb));
  return {
    cover: at(cover, "result", "occurrence"),
    pcb: at(pcb, "result", "occurrence"),
  };
}
export const g36_1 = {
  id: "G36-01",
  title:
    "G36-01: explode.plan yields a deterministic cock/release/return schedule over instances",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const { cover, pcb } = await twoOccurrences(session, "Cover", "Pcb");
    const out = await fmcad([
      "explode",
      "plan",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        occurrences: [
          {
            ref: cover,
            axis: [0, 0, 1],
            distance: "30 mm",
            phase: "release",
            label: "cover",
          },
          {
            ref: pcb,
            axis: [0, 0, 1],
            distance: "15 mm",
            phase: "return",
            label: "pcb",
          },
        ],
        phases: ["cock", "release", "return"],
        disconnections: [{ name: "clip", from: cover, to: pcb }],
        duration: "2 s",
        fps: 30,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "frameCount"), 61, JSON.stringify(out));
    assert.equal(at(out, "result", "fps"), 30, JSON.stringify(out));
    assert.deepEqual(
      list(at(out, "result", "phaseSchedule")).map((p) => at(p, "name")),
      ["cock", "release", "return"],
      JSON.stringify(out),
    );
    assert.deepEqual(
      list(at(out, "result", "order")).map((o) => at(o, "label")),
      ["cover", "pcb"],
      JSON.stringify(out),
    );
    assert.deepEqual(at(out, "result", "blockers"), [], JSON.stringify(out));
    assert.deepEqual(at(out, "result", "cycles"), [], JSON.stringify(out));
    assert.equal(
      list(at(out, "result", "poses")).length,
      at(out, "result", "frameCount"),
      JSON.stringify(out),
    );
    assert.equal(
      list(at(out, "result", "trails")).length,
      2,
      JSON.stringify(out),
    );
    assert.equal(
      list(at(out, "result", "balloons")).length,
      2,
      JSON.stringify(out),
    );
    // Honesty gates: an exploded assembly is not a service-path proof, and no
    // native storyboard action sequence is authored.
    assert.equal(
      at(out, "result", "explodeIsNotServicePath"),
      true,
      JSON.stringify(out),
    );
    assert.equal(
      at(out, "result", "nativeStoryboardActionsCreated"),
      false,
      JSON.stringify(out),
    );
  },
};
export const g36_2 = {
  id: "G36-02",
  title:
    "G36-02: explode.render moves and restores occurrence transforms with trails/balloons",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const { cover } = await twoOccurrences(session, "Cover", "Pcb");
    const out = await fmcad([
      "explode",
      "render",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        occurrences: [
          {
            ref: cover,
            axis: [0, 0, 1],
            distance: "30 mm",
            phase: "release",
            label: "cover",
          },
        ],
        phases: ["cock", "release", "return"],
        duration: "1 s",
        fps: 10,
        confirm: true,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "frameCount"), 11, JSON.stringify(out));
    assert.equal(at(out, "result", "restored"), true, JSON.stringify(out));
    assert.deepEqual(
      at(out, "result", "restoreErrors"),
      [],
      JSON.stringify(out),
    );
    assert.equal(
      at(out, "result", "restoreRequested"),
      true,
      JSON.stringify(out),
    );
    assert.equal(
      list(at(out, "result", "trails")).length,
      1,
      JSON.stringify(out),
    );
    assert.equal(
      list(at(out, "result", "balloons")).length,
      1,
      JSON.stringify(out),
    );
  },
};
export const g36_3 = {
  id: "G36-03",
  title:
    "G36-03: animation.sequence plans camera/visibility/section tracks into a manifest",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "animation",
      "sequence",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        tracks: [
          {
            type: "camera",
            phase: "intro",
            from: {
              eye: ["0 cm", "0 cm", "30 cm"],
              target: ["0 cm", "0 cm", "0 cm"],
              up: [0, 0, 1],
            },
            to: {
              eye: ["10 cm", "0 cm", "30 cm"],
              target: ["0 cm", "0 cm", "0 cm"],
              up: [0, 0, 1],
            },
          },
          {
            type: "visibility",
            phase: "reveal",
            ref: "Sketch1",
            visible: false,
          },
          {
            type: "section",
            phase: "reveal",
            name: "MidSection",
            isLightBulbOn: true,
          },
        ],
        phases: ["intro", "reveal"],
        duration: "2 s",
        fps: 30,
        easing: "easeInOut",
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "frameCount"), 61, JSON.stringify(out));
    assert.equal(
      list(at(out, "result", "frames")).length,
      61,
      JSON.stringify(out),
    );
    assert.equal(at(out, "result", "trackCount"), 3, JSON.stringify(out));
    assert.equal(at(out, "result", "easing"), "easeInOut", JSON.stringify(out));
    assert.deepEqual(
      list(at(out, "result", "phaseSchedule")).map((p) => at(p, "name")),
      ["intro", "reveal"],
      JSON.stringify(out),
    );
    assert.equal(
      at(out, "result", "nativeStoryboardActionsCreated"),
      false,
      JSON.stringify(out),
    );
    // Camera is interpolated; the visibility/section steps apply at their phase start.
    assert.ok(
      at(out, "result", "frames", 0, "camera"),
      JSON.stringify(at(out, "result", "frames", 0)),
    );
    assert.ok(
      at(list(at(out, "result", "frames")).at(-1), "sections", "MidSection") ===
        true,
      JSON.stringify(list(at(out, "result", "frames")).at(-1)),
    );
  },
};
export const g36_4 = {
  id: "G36-04",
  title:
    "G36-04: animation.sequence samples a joint track without authoring native actions",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "animation",
      "sequence",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        tracks: [
          {
            type: "joint",
            ref: { name: "pan" },
            rotation: { from: "0 deg", to: "90 deg" },
          },
          {
            type: "camera",
            ref: { name: "cam" },
            from: {
              eye: ["0 cm", "0 cm", "30 cm"],
              target: ["0 cm", "0 cm", "0 cm"],
              up: [0, 0, 1],
            },
            to: {
              eye: ["0 cm", "0 cm", "20 cm"],
              target: ["0 cm", "0 cm", "0 cm"],
              up: [0, 0, 1],
            },
          },
        ],
        phases: ["sweep"],
        duration: "1 s",
        fps: 10,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "frameCount"), 11, JSON.stringify(out));
    assert.equal(
      at(out, "result", "nativeStoryboardActionsCreated"),
      false,
      JSON.stringify(out),
    );
    // The joint track is interpolated frame by frame; the first and last values
    // differ (0 -> 90 deg).
    assert.ok(
      at(out, "result", "frames", 0, "joints", "pan"),
      JSON.stringify(at(out, "result", "frames", 0)),
    );
    assert.ok(
      number(
        at(
          list(at(out, "result", "frames")).at(-1),
          "joints",
          "pan",
          "rotation",
        ),
      ) > number(at(out, "result", "frames", 0, "joints", "pan", "rotation")),
      JSON.stringify(list(at(out, "result", "frames")).at(-1)),
    );
  },
};
export const g36_5 = {
  id: "G36-05",
  title:
    "G36-05: animation.capabilities reports no native action/video authoring",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "animation",
      "capabilities",
      "--doc",
      doc,
      "--data",
      "{}",
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      at(out, "result", "actionCreation"),
      false,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "videoPublish"),
      false,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "collectionAccess"),
      "notChecked",
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "count"),
      null,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g36_7 = {
  id: "G36-07",
  title:
    "G36-07: explode.plan timing and easing are deterministic (frameCount and phase slices)",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const { cover } = await twoOccurrences(session, "Cover", "Pcb");
    const plan = async (easing: string) =>
      await fmcad([
        "explode",
        "plan",
        "--doc",
        doc,
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          occurrences: [
            {
              ref: cover,
              axis: [0, 0, 1],
              distance: "30 mm",
              phase: "release",
              label: "cover",
            },
          ],
          phases: ["cock", "release", "return"],
          duration: "2 s",
          fps: 30,
          easing,
        }),
      ]);
    const linear = await plan("linear");
    const smooth = await plan("smoothstep");
    assert.equal(
      at(linear, "result", "frameCount"),
      61,
      JSON.stringify(linear),
    );
    assert.equal(
      at(linear, "result", "frameCount"),
      Math.floor(2 * 30) + 1,
      JSON.stringify(linear),
    );
    assert.equal(
      at(linear, "result", "durationSeconds"),
      2,
      JSON.stringify(linear),
    );
    // Phase windows slice the duration into equal spans.
    for (const phase of list(at(linear, "result", "phaseSchedule"))) {
      assert.ok(
        number(at(phase, "endTime")) > number(at(phase, "startTime")),
        JSON.stringify(phase),
      );
    }
    // The final pose reaches axis * distance regardless of easing law.
    const lastLinear = at(
      list(at(linear, "result", "poses")).at(-1),
      "occurrences",
      0,
      "origin",
      2,
    );
    const lastSmooth = at(
      list(at(smooth, "result", "poses")).at(-1),
      "occurrences",
      0,
      "origin",
      2,
    );
    assert.ok(
      Math.abs(number(lastLinear) - 3.0) < 1e-6,
      JSON.stringify(lastLinear),
    );
    assert.ok(
      Math.abs(number(lastSmooth) - 3.0) < 1e-6,
      JSON.stringify(lastSmooth),
    );
    // Mid-window interpolation differs between easing laws (deterministic, not identical).
    assert.notEqual(
      at(linear, "result", "poses", 35, "occurrences", 0, "origin", 2),
      at(smooth, "result", "poses", 35, "occurrences", 0, "origin", 2),
    );
  },
};
export const g36_8 = {
  id: "G36-08",
  title: "G36-08: explode.render restore:false leaves the final exploded pose",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const { cover } = await twoOccurrences(session, "Cover", "Pcb");
    const out = await fmcad([
      "explode",
      "render",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        occurrences: [
          {
            ref: cover,
            axis: [0, 0, 1],
            distance: "30 mm",
            phase: "release",
            label: "cover",
          },
        ],
        phases: ["cock", "release", "return"],
        duration: "1 s",
        fps: 10,
        confirm: true,
        restore: false,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(
      at(out, "result", "restoreRequested"),
      false,
      JSON.stringify(out),
    );
    assert.equal(at(out, "result", "restored"), null, JSON.stringify(out));
  },
};
export const g36_6 = {
  id: "G36-06",
  title: "G36-06 absent encoder refuses film creation",
  async run(session: ScenarioSession) {
    const frames = [0, 1].map((index) =>
      path.join(session.directory, `frame-${index}.png`),
    );
    for (const frame of frames)
      fs.writeFileSync(
        frame,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    const output = path.join(session.directory, "film.mp4");
    const result = await session.execute(
      "animation-no-encoder",
      cadCommand(session.document, "animation.export", {
        schemaVersion: 1,
        frames: frames.map((file) => session.backend.fusionPath(file)),
        output: session.backend.fusionPath(output),
        confirm: true,
      }),
      session.document,
      "cad-v1",
    );
    assert.equal(result["error"], null, JSON.stringify(result));
    const out = record(result["result"]);
    assert.equal(out["status"], "blocked", JSON.stringify(out));
    assert.equal(out["fileWritten"], false, JSON.stringify(out));
    assert.equal(out["playable"], false, JSON.stringify(out));
    assert.equal(out["film"], null, JSON.stringify(out));
    assert.equal(fs.existsSync(output), false);
  },
};
export const gm36Cases = [
  g36_1,
  g36_2,
  g36_3,
  g36_4,
  g36_5,
  g36_6,
  g36_7,
  g36_8,
];
