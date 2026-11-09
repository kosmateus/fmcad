import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Scenario } from "./runner";
import {
  number,
  record,
  text,
  type Document,
  type ScenarioBackend,
} from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { emit, program } from "./programs";
import {
  nativeModelingHarness,
  nativeResultUncertain,
  values,
} from "./native-modeling-support";

export const nativeFileExportsCapability = "native-file-exports";
const retainedSource = "tests/live-file-exports.js";
const operations = [
  "export.step",
  "export.mesh",
  "export.parts",
  "export.verify",
];
const suffixes = {
  step: ".step",
  stl: ".stl",
  partsStep: "_parts.step",
  partsStl: "_parts.stl",
} as const;
type FileKey = keyof typeof suffixes;

/** Paths are generated from durable owner identity, never supplied by a caller. */
export function ownedExportPaths(session: {
  directory: string;
  document: Document;
  backend: Pick<ScenarioBackend, "fusionPath">;
}) {
  const parent = path.resolve(session.directory);
  const nativeParent = session.backend.fusionPath(parent);
  assert.ok(
    path.win32.isAbsolute(nativeParent),
    "Export directory must be an absolute native path.",
  );
  const prefix = session.document.name;
  assert.match(prefix, /^FMCAD_SCENARIO_[a-zA-Z0-9_-]+$/u);
  const files = (Object.entries(suffixes) as [FileKey, string][]).map(
    ([key, suffix]) => {
      const local = path.join(parent, prefix + suffix);
      const native = session.backend.fusionPath(local);
      assert.equal(path.dirname(local), parent);
      assert.equal(
        path.win32.dirname(native),
        path.win32.normalize(nativeParent),
      );
      assert.equal(path.win32.basename(native), prefix + suffix);
      return { key, local, native };
    },
  );
  assert.equal(new Set(files.map((file) => file.native)).size, 4);
  return { parent, nativeParent, prefix, files };
}

/** Real STEP/STL/BRep results stay native-only; the existing runner owns SDK ordering. */
export function nativeFileExportScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-file-exports-" + index,
    requires: ["documents", nativeFileExportsCapability],
    scope: "exclusive-instance",
    async run(session) {
      const harness = await nativeModelingHarness(
        session,
        retainedSource,
        ["shape.box"],
        operations,
        { honorResultStatus: true },
      );
      const { cad, check, validated, guard } = harness;
      const owned = ownedExportPaths(session);
      const paths = Object.fromEntries(
        owned.files.map((file) => [file.key, file.native]),
      ) as Record<FileKey, string>;
      const evidence: Record<string, unknown> = {
        retainedSource,
        owner: session.report.owner,
        document: session.document,
        files: owned.files,
        qualification: "native-observation-required",
      };
      const persist = () =>
        fs.writeFileSync(
          path.join(session.directory, "native-file-exports.json"),
          JSON.stringify(evidence, null, 2) + "\n",
          { mode: 0o600 },
        );
      persist(); // Ownership intent precedes every file mutation.
      let sequence = 0;
      const probe = async (
        phase: string,
        body: string,
        expression: string,
        mutation = false,
      ) => {
        await guard();
        const source = program(`import adsk.core, json, os, hashlib
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(session.document.creationId)} and d.name == ${JSON.stringify(session.document.name)}]
assert len(matches) == 1, 'Owned identity is ambiguous or missing'
doc = matches[0]
assert not doc.isSaved and doc.dataFile is None and app.activeDocument == doc, 'Owned active unsaved guard failed'
${body}
${emit(`dict(creationId=doc.creationId, result=${expression})`)}`);
        const value = mutation
          ? await session.execute(
              "file-exports-" + phase + "-" + sequence++,
              source,
            )
          : await session.observe(
              "observe-file-exports-" + phase + "-" + sequence++,
              source,
            );
        if (nativeResultUncertain(value))
          session.deferCleanup(
            "File export probe returned unknown/pending; do not replay.",
          );
        const result = record(value["result"]);
        evidence[phase] = result;
        persist();
        return result;
      };
      let ownedPathsAbsent = false;
      let failure: unknown;
      try {
        const box = await cad("shape.box", {
          name: "ExportBody",
          width: "10 mm",
          depth: "20 mm",
          height: "30 mm",
        });
        check(
          "shape.box",
          "one native export fixture body created",
          values(box["bodies"]).length,
          1,
        );
        validated("shape.box");
        const body = values(box["bodies"])[0];
        const preflight = await probe(
          "preflight",
          `targets = ${JSON.stringify(owned.files.map((file) => file.native))}
existing = [filename for filename in targets if os.path.lexists(filename)]`,
          "dict(targets=targets, existing=existing)",
        );
        assert.deepEqual(
          preflight["existing"],
          [],
          "A unique owned export path already exists.",
        );
        ownedPathsAbsent = true;

        const step = await cad("export.step", {
          path: paths.step,
          ref: "root",
        });
        check(
          "export.step",
          "native STEP export reports a nonempty file",
          step["exists"] && number(step["bytes"]) > 0,
          true,
        );
        check(
          "export.step",
          "native STEP output path is exact",
          path.win32.normalize(text(step["path"])),
          path.win32.normalize(paths.step),
        );
        validated("export.step");
        const verified = await cad("export.verify", {
          path: paths.step,
          reimport: true,
          ref: "root",
          lengthTolerance: "0.001 mm",
        });
        check(
          "export.verify",
          "STEP reimport verification completes",
          verified["reimported"],
          true,
        );
        check(
          "export.verify",
          "STEP BRep bounds are within native tolerance",
          record(verified["comparison"])["withinTolerance"],
          true,
        );
        validated("export.verify");
        const mesh = await cad("export.mesh", {
          path: paths.stl,
          ref: body,
          units: "mm",
          surfaceDeviation: "0.1 mm",
        });
        check(
          "export.mesh",
          "native STL export reports a nonempty file",
          mesh["exists"] && number(mesh["bytes"]) > 84,
          true,
        );
        check(
          "export.mesh",
          "STL units are explicit",
          record(mesh["tessellation"])["surfaceDeviation"],
          "0.1 mm",
        );
        validated("export.mesh");
        const parts = await cad("export.parts", {
          parts: [
            { ref: "root", format: "step", path: paths.partsStep },
            { ref: body, format: "mesh", path: paths.partsStl, units: "mm" },
          ],
        });
        const files = values(parts["files"]).map(record);
        check(
          "export.parts",
          "two explicit part files returned",
          files.length,
          2,
        );
        check(
          "export.parts",
          "STEP part is nonempty",
          record(files[0])["exists"] && number(record(files[0])["bytes"]) > 0,
          true,
        );
        check(
          "export.parts",
          "STL part is nonempty",
          record(files[1])["exists"] && number(record(files[1])["bytes"]) > 84,
          true,
        );
        check(
          "export.parts",
          "parts exporter reports non-atomic semantics",
          parts["atomic"],
          false,
        );
        validated("export.parts");
        // The retained script called validated(export.verify) three times for one
        // invocation. Keep its two BRep assertions, and mark that invocation once.
        const proof = await probe(
          "binary-readback",
          `paths = ${JSON.stringify(owned.files.map((file) => file.native))}
rows = []
for filename in paths:
    assert os.path.isfile(filename) and not os.path.islink(filename)
    with open(filename, 'rb') as stream:
        content = stream.read()
    rows.append(dict(path=filename, bytes=len(content), sha256=hashlib.sha256(content).hexdigest(), prefix=content[:16].hex()))
step = next(row for row in rows if row['path'] == ${JSON.stringify(paths.step)})
assert bytes.fromhex(step['prefix']).startswith(b'ISO-10303-21;')`,
          "dict(files=rows)",
        );
        const rows = values(proof["files"]).map(record);
        assert.equal(rows.length, 4);
        for (const file of owned.files) {
          const matches = rows.filter((row) => row["path"] === file.native);
          assert.equal(
            matches.length,
            1,
            "Each exact owned path requires one readback.",
          );
          const row = record(matches[0]);
          const stat = fs.lstatSync(file.local);
          assert.ok(stat.isFile() && !stat.isSymbolicLink());
          const bytes = fs.readFileSync(file.local);
          assert.equal(bytes.length, row["bytes"]);
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            row["sha256"],
          );
          assert.equal(bytes.subarray(0, 16).toString("hex"), row["prefix"]);
        }
        check(
          "export.step",
          "STEP ISO-10303 header read back",
          text(
            record(rows.find((row) => row["path"] === paths.step))["prefix"],
          ).startsWith("49534f2d31303330332d32313b"),
          true,
        );
        evidence["readbackPassed"] = true;
      } catch (error) {
        failure = error;
        evidence["failure"] = String(error);
      } finally {
        persist();
      }
      if (session.uncertain) {
        if (!session.report.cleanupHold)
          session.deferCleanup(
            "An export request is unsettled; preserve its files and fixture without retry.",
          );
        throw failure;
      }
      if (ownedPathsAbsent) {
        try {
          const cleanup = await probe(
            "file-cleanup",
            `owned = ${JSON.stringify(owned.files.map((file) => file.native))}
root = os.path.abspath(${JSON.stringify(owned.nativeParent)})
for filename in owned:
    assert os.path.dirname(os.path.abspath(filename)) == root
    assert os.path.basename(filename).startswith(${JSON.stringify(owned.prefix)})
    if os.path.lexists(filename):
        assert os.path.isfile(filename) and not os.path.islink(filename), 'Owned output is not a regular file'
        os.remove(filename)
remaining = [filename for filename in owned if os.path.lexists(filename)]
assert not remaining`,
            "dict(removed=owned, remaining=remaining)",
            true,
          );
          assert.deepEqual(
            cleanup["removed"],
            owned.files.map((file) => file.native),
          );
          assert.deepEqual(cleanup["remaining"], []);
          for (const file of owned.files)
            assert.equal(fs.existsSync(file.local), false);
        } catch (error) {
          evidence["cleanupError"] = String(error);
          persist();
          session.deferCleanup(
            "Owned export file cleanup was not verified; preserve the fixture and original requests for inspection.",
          );
        }
      }
      await guard();
      persist();
      if (failure !== undefined) throw failure;
    },
  }));
}
