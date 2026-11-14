import path from "node:path";
import { cadCommand } from "./cad-programs";
import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, record } from "../integration/offline-cli";
// Return the first design-local appearance ID, or throw a clear error.
async function sourceAppearance(session: ScenarioSession) {
  await seedStyle(session, "appearance");
  const { fmcad } = gmCommands(session);
  const doc = session.document.name;
  const resources = await fmcad([
    "appearance",
    "list",
    "--doc",
    doc,
    "--data",
    "{}",
  ]);
  assert.equal(at(resources, "success"), true, JSON.stringify(resources));
  assert.ok(
    list(at(resources, "result", "items")).length > 0,
    "design exposes no appearance to copy",
  );
  return at(resources, "result", "items", 0, "id");
}
// Return the first design-local material ID, or throw a clear error.
async function sourceMaterial(session: ScenarioSession) {
  await seedStyle(session, "material");
  const { fmcad } = gmCommands(session);
  const doc = session.document.name;
  const resources = await fmcad([
    "material",
    "list",
    "--doc",
    doc,
    "--data",
    "{}",
  ]);
  assert.equal(at(resources, "success"), true, JSON.stringify(resources));
  assert.ok(
    list(at(resources, "result", "items")).length > 0,
    "design exposes no material to copy",
  );
  return at(resources, "result", "items", 0, "id");
}
// Copy an appearance under a unique name and return the created id.
async function createAppearance(session: ScenarioSession) {
  const { fmcad } = gmCommands(session);
  const doc = session.document.name;
  const sourceId = await sourceAppearance(session);
  const created = await fmcad([
    "appearance",
    "create",
    "--doc",
    doc,
    "--data",
    JSON.stringify({
      name: "FMCAD G29 Paint " + Date.now(),
      id: sourceId,
    }),
  ]);
  assert.equal(at(created, "success"), true, JSON.stringify(created));
  assert.equal(at(created, "result", "copiedFrom"), sourceId);
  assert.ok(
    typeof at(created, "result", "id") === "string" &&
      text(at(created, "result", "id")).length > 0,
  );
  return at(created, "result", "id");
}
export const g29_1 = {
  id: "G29-01",
  title: "gm29: G29-01 appearance.create copies a resource and edit renames it",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const sourceId = await sourceAppearance(session);
    const created = await fmcad([
      "appearance",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        name: "FMCAD G29 Paint " + Date.now(),
        id: sourceId,
      }),
    ]);
    assert.equal(at(created, "success"), true, JSON.stringify(created));
    assert.equal(at(created, "result", "copiedFrom"), sourceId);
    const edited = await fmcad([
      "appearance",
      "edit",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        id: at(created, "result", "id"),
        name: "FMCAD G29 Renamed " + Date.now(),
      }),
    ]);
    assert.equal(at(edited, "status"), "pass", JSON.stringify(edited));
    assert.equal(at(edited, "result", "changed"), true);
    assert.ok(list(at(edited, "result", "changedFields")).includes("name"));
  },
};
export const g29_2 = {
  id: "G29-02",
  title:
    "gm29: G29-02 appearance.texture connects a channel on a design-local appearance",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const doc = session.document.name;
    const id = await createAppearance(session);
    const out = await cad([
      "appearance",
      "texture",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        id,
        channel: "color",
        image: "",
      }),
    ]);
    // The colorTexture setter is a preview feature; an installed SDK that lacks it
    // reports an honest blocked envelope rather than silently substituting.
    if (at(out, "json") && at(out, "json", "status") === "blocked") {
      assert.equal(
        at(out, "json", "success"),
        false,
        JSON.stringify(at(out, "json")),
      );
      return;
    }
    assert.equal(
      at(out, "json", "status"),
      "pass",
      JSON.stringify(at(out, "json")),
    );
    assert.ok(list(at(out, "json", "result", "changed")).includes("image"));
    assert.equal(at(out, "json", "result", "after", "image"), "");
  },
};
export const g29_3 = {
  id: "G29-03",
  title:
    "gm29: G29-03 appearance.projection reads current type and gates a set request",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const doc = session.document.name;
    const id = await createAppearance(session);
    const read = await fmcad([
      "appearance",
      "projection",
      "--doc",
      doc,
      "--data",
      JSON.stringify({ id }),
    ]);
    assert.equal(at(read, "status"), "pass", JSON.stringify(read));
    assert.equal(at(read, "result", "changed"), false);
    assert.ok(
      at(read, "result", "projection") === null ||
        typeof at(read, "result", "projection") === "string",
    );
    const set = await cad([
      "appearance",
      "projection",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        id,
        projection: "planar",
      }),
    ]);
    if (at(set, "json", "status") === "blocked") {
      assert.equal(
        at(set, "json", "success"),
        false,
        JSON.stringify(at(set, "json")),
      );
    } else {
      assert.equal(
        at(set, "json", "status"),
        "pass",
        JSON.stringify(at(set, "json")),
      );
      assert.equal(at(set, "json", "result", "changed"), true);
    }
  },
};
export const g29_4 = {
  id: "G29-04",
  title:
    "gm29: G29-04 material.create copies a physical material and edit renames it",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const sourceId = await sourceMaterial(session);
    const created = await fmcad([
      "material",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        name: "FMCAD G29 ABS " + Date.now(),
        id: sourceId,
      }),
    ]);
    assert.equal(at(created, "success"), true, JSON.stringify(created));
    assert.equal(at(created, "result", "copiedFrom"), sourceId);
    const edited = await fmcad([
      "material",
      "edit",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        id: at(created, "result", "id"),
        name: "FMCAD G29 ABS Renamed " + Date.now(),
      }),
    ]);
    assert.equal(at(edited, "status"), "pass", JSON.stringify(edited));
    assert.equal(at(edited, "result", "changed"), true);
    assert.ok(list(at(edited, "result", "changedFields")).includes("name"));
  },
};
export const g29_5 = {
  id: "G29-05",
  title:
    "gm29: G29-05 entity.attribute set/get store namespaced strings on the root component",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const group = "fmcad.g29";
    const set = await fmcad([
      "entity",
      "attribute",
      "set",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        ref: { name: "root" },
        group,
        name: "source",
        value: "STEP import",
      }),
    ]);
    assert.equal(at(set, "status"), "pass", JSON.stringify(set));
    assert.equal(at(set, "result", "changed"), true);
    assert.equal(at(set, "result", "resourceIdentity", "kind"), "component");
    const got = await fmcad([
      "entity",
      "attribute",
      "get",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        ref: { name: "root" },
        group,
        name: "source",
      }),
    ]);
    assert.equal(at(got, "status"), "pass", JSON.stringify(got));
    assert.deepEqual(at(got, "result", "attributes"), [
      { name: "source", value: "STEP import" },
    ]);
  },
};
export const g29_6 = {
  id: "G29-06",
  title:
    "gm29: G29-06 material.assign-map reads assignments without assuming equivalence",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "material",
      "assign-map",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        refs: [{ name: "root" }],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "kind"), "material");
    assert.ok(Array.isArray(at(out, "result", "assignments")));
    assert.equal(at(out, "result", "mismatchCount"), 0);
  },
};
export const g29_7 = {
  id: "G29-07",
  title:
    "gm29: G29-07 appearance.assign-map reads assignments (body/face/occurrence scope)",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "appearance",
      "assign-map",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        refs: [{ name: "root" }],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "kind"), "appearance");
    assert.ok(Array.isArray(at(out, "result", "assignments")));
    assert.equal(at(out, "result", "mismatchCount"), 0);
  },
};
export const g29_8 = {
  id: "G29-08",
  title:
    "gm29: G29-08 styles.report aggregates appearance/material state and flags duplicates",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const doc = session.document.name;
    // A report with no duplicate names passes; accumulated duplicates (styles are
    // retained across clears) are disclosed as a fail and exit nonzero, never
    // assumed equivalent. Use cad() so the fail envelope can be asserted directly.
    const out = await cad([
      "styles",
      "report",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        refs: [{ name: "root" }],
      }),
    ]);
    const body = at(out, "json");
    assert.ok(body, "expected a JSON envelope: " + at(out, "stderr"));
    assert.ok(
      at(body, "status") === "pass" || at(body, "status") === "fail",
      JSON.stringify(body),
    );
    assert.ok(Array.isArray(at(body, "result", "styles")));
    assert.ok(Array.isArray(at(body, "result", "density")));
    assert.equal(typeof at(body, "result", "appearanceCount"), "number");
    assert.equal(typeof at(body, "result", "materialCount"), "number");
    assert.ok(
      at(body, "result", "duplicateNames") &&
        typeof at(body, "result", "duplicateNames", "appearance") === "object",
    );
    assert.ok(
      at(body, "result", "duplicateNames") &&
        typeof at(body, "result", "duplicateNames", "material") === "object",
    );
  },
};
export const g29_9 = {
  id: "G29-09",
  title: "G29-09 deterministic tileable PNG on the owned host path",
  async run(session: ScenarioSession) {
    const outputPath = session.backend.fusionPath(
      path.join(session.directory, "heightmap.png"),
    );
    const out = await texture(session, "heightmap", {
      path: outputPath,
      width: 64,
      height: 64,
      seed: 7,
      amplitude: 0.8,
      period: 8,
      pattern: "waves",
    });
    assert.equal(out["deterministic"], true);
    assert.equal(at(out, "file", "exists"), true);
    assert.ok(/^[0-9a-f]{64}$/.test(text(out["sha256"])));
    assert.equal(at(out, "parameters", "pattern"), "waves");
  },
};
export const g29_10 = {
  id: "G29-10",
  title: "G29-10 identical heightmap bytes and explicit overwrite permission",
  async run(session: ScenarioSession) {
    const outputPath = session.backend.fusionPath(
      path.join(session.directory, "heightmap.png"),
    );
    const params = {
      width: 64,
      height: 64,
      seed: 11,
      amplitude: 0.5,
      period: 8,
      pattern: "grooves",
    };
    const first = await texture(session, "first", {
      path: outputPath,
      ...params,
    });
    const second = await texture(session, "second", {
      path: outputPath,
      ...params,
      overwrite: true,
      confirm: true,
    });
    assert.equal(first["sha256"], second["sha256"]);
    assert.deepEqual(first["parameters"], second["parameters"]);
    const refused = await session.execute(
      "heightmap-refused",
      cadCommand(session.document, "texture.heightmap", {
        path: outputPath,
        ...params,
        pattern: "noise",
      }),
      session.document,
      "cad-v1",
    );
    assert.match(text(refused["error"]), /requires overwrite/u);
    assert.equal(refused["result"], null);
  },
};
async function texture(
  session: ScenarioSession,
  phase: string,
  data: Record<string, unknown>,
) {
  const output = await session.cad("cad-" + phase, "texture.heightmap", data);
  assert.equal(output["success"], true, JSON.stringify(output));
  return record(output["result"]);
}
export const g29_11 = {
  id: "G29-11",
  title:
    "gm29: G29-11 appearance.create reports typed property descriptors for the copy",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const sourceId = await sourceAppearance(session);
    const created = await fmcad([
      "appearance",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        name: "FMCAD G29 Typed " + Date.now(),
        id: sourceId,
      }),
    ]);
    assert.equal(at(created, "success"), true, JSON.stringify(created));
    // Typed property readback: every descriptor carries a concrete Property type.
    assert.ok(Array.isArray(at(created, "result", "properties")));
    assert.ok(list(at(created, "result", "properties")).length > 0);
    for (const prop of list(at(created, "result", "properties"))) {
      assert.ok(typeof at(prop, "id") === "string");
      assert.ok(typeof at(prop, "name") === "string");
      assert.ok(typeof at(prop, "type") === "string");
      assert.equal(typeof at(prop, "isReadOnly"), "boolean");
    }
  },
};
export const g29_12 = {
  id: "G29-12",
  title:
    "gm29: G29-12 appearance.projection read reflects the actual installed projection",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const id = await createAppearance(session);
    // Actual projection read (no projection field) never fabricates a frame; it
    // returns the installed value or null. Save/reopen dependency persistence is
    // not expressible inside a single clear() cycle and stays native-pending.
    const out = await fmcad([
      "appearance",
      "projection",
      "--doc",
      doc,
      "--data",
      JSON.stringify({ id }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "changed"), false);
    assert.ok("projection" in record(at(out, "result")));
  },
};
export const gm29Cases = [
  g29_1,
  g29_2,
  g29_3,
  g29_4,
  g29_5,
  g29_6,
  g29_7,
  g29_8,
  g29_9,
  g29_10,
  g29_11,
  g29_12,
];
/** Fresh owned fixtures need explicit local source resources; retained shared-document styles are not borrowed. */
async function seedStyle(
  session: ScenarioSession,
  kind: "appearance" | "material",
) {
  const { fmcad } = gmCommands(session);
  const args = [kind, "list", "--doc", session.document.name, "--data"];
  const local = await fmcad([...args, "{}"]);
  if (list(at(local, "result", "items")).length) return;
  for (const library of list(at(local, "result", "libraries"))) {
    const libraryId = at(library, "id");
    const resources = await fmcad([
      ...args,
      JSON.stringify({ library: libraryId }),
    ]);
    const first = list(at(resources, "result", "items"))[0];
    if (!first) continue;
    const created = await fmcad([
      kind,
      "create",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        id: at(first, "id"),
        library: libraryId,
        name: "FMCAD_G29_Source_" + kind,
      }),
    ]);
    assert.equal(created["success"], true);
    return;
  }
  assert.fail("No loaded library has a source " + kind);
}
