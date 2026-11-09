import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Scenario } from "./runner";
import { record, text, number } from "./contracts";
import { nativeModelingHarness, values } from "./native-modeling-support";
const { catalog } = createRequire(
  path.resolve(__dirname, "../../../package.json"),
)("./src/cad") as typeof import("../../src/composition/cad-execution");
export const nativeEngineeringCapability = "native-engineering-readbacks";
const targetOperations = [
  "entity.stats",
  "measure.area",
  "measure.angle",
  "measure.distance",
  "measure.length",
  "measure.draft",
  "measure.region",
  "measure.corridor",
  "measure.wall-map",
  "cam.profile",
  "cam.evaluate",
  "cam.cycle-check",
  "assembly.sequence",
  "service.path-check",
  "tool.access",
  "fixture.access",
  "snapshot",
  "diff",
  "status",
  "report",
  "audit",
  "check",
  "assembly.motion_check",
  "frame.context_audit",
  "seal.profile",
  "seal.gland",
  "seal.evaluate",
  "dock.sequence-check",
  "shape.helix",
  "optics.frustum",
  "optics.coverage",
  "optics.occlusion",
  "sensor.alignment-check",
  "mount.check",
  "fastener.stack",
  "fastener.check",
  "fastener.schedule",
  "bearing.stack-check",
  "shaft.interface",
  "retention.bayonet",
  "snap.define",
  "snap.evaluate",
  "gear.pair-check",
  "datum.frame",
  "datum.transform",
  "datum.plane-on-path",
  "motion.envelope",
  "clearance.grid",
  "connector.mate-check",
  "keepout.check",
  "feature.dependencies",
  "pack.cross-section",
  "port.define",
  "undercut.check",
];
function field(value: unknown, ...keys: (string | number)[]): unknown {
  return keys.reduce<unknown>(
    (current, key) =>
      typeof key === "number"
        ? values(current)[key]
        : key === "length" && Array.isArray(current)
          ? current.length
          : record(current)[key],
    value,
  );
}
export const engineeringAnalyticDeclarationGroups = [
  "declared-analytic-draft-region-corridor-and-wall-map",
  "analytic-cam-profile-and-limit-evaluation",
  "explicit-cam-cycle-resolution",
  "assembly-sequence-dependency-and-service-order",
  "sampled-service-withdrawal-clearance",
  "declared-bounds-motion-envelope",
  "declared-connector-keying-and-keepout",
  "declared-pcb-packing-port-and-undercut",
  "declared-seal-profile-gland-evaluation-and-dock-order",
  "sampled-helix-recipe-without-native-coil",
  "declared-optical-frustum-coverage-and-occlusion",
  "declared-fastener-bearing-mount-and-shaft-analytics",
  "declared-involute-gear-pair-check",
  "named-datum-frame-and-root-transform",
  "cylindrical-tool-access-and-fixture-seating",
] as const;
const engineeringAnalyticDeclarationOperations = [
  "measure.draft",
  "measure.region",
  "measure.corridor",
  "measure.wall-map",
  "cam.profile",
  "cam.evaluate",
  "cam.cycle-check",
  "assembly.sequence",
  "service.path-check",
  "motion.envelope",
  "connector.mate-check",
  "keepout.check",
  "pack.cross-section",
  "port.define",
  "undercut.check",
  "seal.profile",
  "seal.gland",
  "seal.evaluate",
  "dock.sequence-check",
  "shape.helix",
  "snapshot",
  "optics.frustum",
  "optics.coverage",
  "optics.occlusion",
  "sensor.alignment-check",
  "mount.check",
  "fastener.stack",
  "fastener.check",
  "fastener.schedule",
  "bearing.stack-check",
  "shaft.interface",
  "retention.bayonet",
  "snap.define",
  "snap.evaluate",
  "gear.pair-check",
  "datum.frame",
  "datum.transform",
  "tool.access",
  "fixture.access",
];
export function engineeringAnalyticDeclarationScenarios(
  owners = 10,
): Scenario[] {
  return nativeEngineeringScenarios(owners, true);
}
export function nativeEngineeringScenarios(
  owners = 10,
  declarationsOnly = false,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id:
      (declarationsOnly ? "retained-engineering-" : "native-engineering-") +
      index,
    scope: "exclusive-instance",
    requires: [
      "documents",
      declarationsOnly
        ? "engineering-declarations"
        : nativeEngineeringCapability,
    ],
    async run(session) {
      const harness = await nativeModelingHarness(
        session,
        "tests/live-engineering-analytics.js",
        declarationsOnly ? ["shape.box"] : ["shape.box", "entity.find"],
        declarationsOnly
          ? engineeringAnalyticDeclarationOperations
          : targetOperations,
        { honorResultStatus: true },
      );
      const { check, validated, guard } = harness;
      const report = {
        tests: [] as {
          name: string;
          status: string;
          operations: string[];
          reason?: string;
          error?: string;
          blocker?: string;
        }[],
      };
      const persist = () =>
        fs.writeFileSync(
          path.join(session.directory, "engineering-cases.json"),
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      let body: unknown, failure: unknown, blockedReason: string | undefined;
      const cad = async (
        operation: string,
        data: Record<string, unknown>,
        mutating = !catalog[operation]?.readOnly,
        component = "root",
      ) => {
        try {
          return await harness.cad(operation, data, component, mutating);
        } catch (error) {
          if (
            /EPOCH_CLIENT_NOT_GRANTED|no modeling grant|Unsupported fmcad configuration/u.test(
              String(error),
            )
          )
            blockedReason = String(error);
          throw error;
        }
      };
      async function runCase(
        name: string,
        operations: string[],
        fn: () => Promise<void>,
        requiresBody = true,
      ) {
        if (
          declarationsOnly &&
          !engineeringAnalyticDeclarationGroups.some((group) => group === name)
        )
          return;
        if ((requiresBody && !body) || session.uncertain || blockedReason) {
          report.tests.push({
            name,
            status: session.uncertain ? "unknown" : "not-run",
            operations,
            reason:
              blockedReason ??
              (session.uncertain
                ? "Earlier operation outcome is uncertain; stop without replay."
                : "Native BRep fixture creation failed."),
          });
          persist();
          return;
        }
        try {
          await fn();
          report.tests.push({ name, status: "pass", operations });
        } catch (error) {
          failure ??= error;
          report.tests.push({
            name,
            status: session.uncertain
              ? "unknown"
              : blockedReason
                ? "blocked"
                : "fail",
            operations,
            error: String(error),
            ...(blockedReason ? { blocker: blockedReason } : {}),
          });
        }
        persist();
      }
      // ORIGINAL_NATIVE_BODY
      try {
        await guard();
        const made = await cad("shape.box", {
          name: "MeasurementBlock",
          width: "10 mm",
          depth: "20 mm",
          height: "30 mm",
        });
        check(
          "shape.box",
          "one isolated measurement body created",
          field(made, "bodies", "length"),
          1,
        );
        validated("shape.box");
        body = field(made, "bodies", 0);
        report.tests.push({
          name: "isolated-measurement-fixture",
          status: "pass",
          operations: ["shape.box"],
        });
        persist();
      } catch (error) {
        failure = error;
        report.tests.push({
          name: "isolated-measurement-fixture",
          status: session.uncertain
            ? "unknown"
            : blockedReason
              ? "blocked"
              : "fail",
          operations: ["shape.box"],
          error: String(error),
          ...(blockedReason ? { blocker: blockedReason } : {}),
        });
      }
      await runCase(
        "native-face-area",
        ["entity.find", "measure.area"],
        async () => {
          const top = await cad("entity.find", {
            kind: "face",
            filters: {
              geometry: "plane",
              axis: [0, 0, 1],
              position: ["0 mm", "0 mm", "30 mm"],
            },
            unique: true,
          });
          check(
            "entity.find",
            "top planar face resolved",
            field(top, "kind"),
            "face",
          );
          validated("entity.find");
          const area = await cad("measure.area", { ref: top, units: "mm2" });
          check(
            "measure.area",
            "10×20 mm top-face area",
            field(area, "value"),
            200,
            0.001,
          );
          check(
            "measure.area",
            "area units are mm2",
            field(area, "units"),
            "mm2",
          );
          validated("measure.area");
        },
      );
      await runCase(
        "native-topology-statistics",
        ["entity.stats"],
        async () => {
          const stats = await cad("entity.stats", {
            kind: "face",
            filters: { geometry: "plane" },
            expect: 6,
            groupBy: ["geometry"],
          });
          check(
            "entity.stats",
            "six planar BRep faces are counted",
            field(stats, "count"),
            6,
          );
          check(
            "entity.stats",
            "declared face-count expectation passes",
            field(stats, "expect", "passed"),
            true,
          );
          check(
            "entity.stats",
            "all six face areas are measured",
            field(stats, "statistics", "area", "count"),
            6,
          );
          check(
            "entity.stats",
            "native box total surface area in cm2",
            field(stats, "statistics", "area", "sum"),
            22,
            1e-7,
          );
          check(
            "entity.stats",
            "all planar face area results are present",
            field(stats, "statistics", "area", "missing"),
            0,
          );
          check(
            "entity.stats",
            "geometry grouping returns one plane group with six members",
            field(stats, "groups", "length") === 1 &&
              field(stats, "groups", 0, "count") === 6,
            true,
          );
          validated("entity.stats");
        },
      );
      await runCase(
        "native-model-parameter-dependency-readback",
        ["feature.dependencies"],
        async () => {
          const dependencies = await cad("feature.dependencies", {});
          check(
            "feature.dependencies",
            "coverage is explicitly partial, not a complete feature DAG",
            field(dependencies, "coverage"),
            "partial",
          );
          check(
            "feature.dependencies",
            "native box model parameters are enumerated",
            number(field(dependencies, "parameters", "length")) > 0,
            true,
          );
          check(
            "feature.dependencies",
            "every returned row identifies expression and unavailable-or-read dependency lists",
            values(field(dependencies, "parameters")).every(
              (row) =>
                typeof field(row, "name") === "string" &&
                typeof field(row, "expression") === "string" &&
                (Array.isArray(field(row, "dependsOn")) ||
                  field(row, "dependsOn") === null) &&
                (Array.isArray(field(row, "usedByParameters")) ||
                  field(row, "usedByParameters") === null),
            ),
            true,
          );
          check(
            "feature.dependencies",
            "known limitations explain partial dependency coverage",
            values(field(dependencies, "limitations")).some((item) =>
              values(item).includes("not every feature"),
            ),
            true,
          );
          validated("feature.dependencies");
        },
      );
      await runCase(
        "snapshot-diff-status-audit-and-check-report",
        ["snapshot", "diff", "status", "audit", "check", "report"],
        async () => {
          const before = await cad("snapshot", {});
          check(
            "snapshot",
            "snapshot uses the documented v1 schema",
            field(before, "schema"),
            "fmcad.measure.snapshot.v1",
          );
          check(
            "snapshot",
            "initial snapshot includes the native fixture body",
            field(before, "counts", "bodyDefinitions"),
            1,
          );
          validated("snapshot");
          const audit = await cad("audit", {});
          check(
            "audit",
            "audit reports the same native body-definition count",
            field(audit, "counts", "bodyDefinitions"),
            1,
          );
          check(
            "audit",
            "audit returns a full versioned observation",
            field(audit, "schema"),
            "fmcad.measure.snapshot.v1",
          );
          validated("audit");
          const status = await cad("status", {});
          check(
            "status",
            "observed status never claims acceptance",
            field(status, "acceptance"),
            "notEvaluated",
          );
          check(
            "status",
            "status body-definition count matches the snapshot",
            field(status, "counts", "bodyDefinitions"),
            1,
          );
          validated("status");
          const checked = await cad("check", {
            id: "box-volume",
            source: "declared-analytic-fixture",
            measurement: {
              operation: "measure.volume",
              data: { ref: body, units: "mm3" },
            },
            expected: "6000 mm3",
            tolerance: "0.01 mm3",
          });
          check(
            "check",
            "scalar volume check passes the exact 10×20×30 mm body",
            field(checked, "passed"),
            true,
          );
          check(
            "check",
            "check returns its caller requirement ID and evidence label",
            field(checked, "id") + "|" + field(checked, "source"),
            "box-volume|declared-analytic-fixture",
          );
          check(
            "check",
            "nested measured value is 6000 mm3",
            field(checked, "actual", "value"),
            6000,
            0.01,
          );
          validated("check");
          const reportResult = await cad("report", {
            checks: [
              {
                measurement: {
                  operation: "measure.volume",
                  data: { ref: body, units: "mm3" },
                },
                min: "5999 mm3",
              },
            ],
            metadata: { reviewer: "coverage-test" },
          });
          check(
            "report",
            "report evaluates the supplied scalar check",
            field(reportResult, "checkOutcome"),
            "pass",
          );
          check(
            "report",
            "reported observed status remains not-evaluated",
            field(reportResult, "status", "acceptance"),
            "notEvaluated",
          );
          check(
            "report",
            "user metadata is preserved but not treated as verified",
            field(reportResult, "metadataVerified"),
            false,
          );
          check(
            "report",
            "user metadata is returned verbatim",
            field(reportResult, "userMetadata", "reviewer"),
            "coverage-test",
          );
          validated("report");
          await cad("shape.box", {
            name: "SnapshotSecondBody",
            width: "2 mm",
            depth: "3 mm",
            height: "4 mm",
          });
          validated("shape.box");
          const after = await cad("snapshot", {});
          check(
            "snapshot",
            "second native snapshot observes the added body",
            field(after, "counts", "bodyDefinitions"),
            2,
          );
          validated("snapshot");
          const difference = await cad("diff", { before, after });
          check(
            "diff",
            "structural snapshot diff detects the body addition",
            field(difference, "changed"),
            true,
          );
          check(
            "diff",
            "diff identifies an added BRep body entry",
            values(field(difference, "changes")).some(
              (item) =>
                values(field(item, "path")).includes("/bodies") &&
                field(item, "change") === "added",
            ),
            true,
          );
          validated("diff");
        },
      );
      await runCase(
        "native-finite-edge-length",
        ["entity.find", "measure.length"],
        async () => {
          const edges = await cad("entity.find", {
            kind: "edge",
            filters: { geometry: "line", axis: [1, 0, 0], length: "10 mm" },
            expect: 4,
          });
          check(
            "entity.find",
            "four horizontal 10 mm BRep edges found",
            field(edges, "entities", "length"),
            4,
          );
          validated("entity.find");
          const length = await cad("measure.length", {
            ref: field(edges, "entities", 0),
            units: "mm",
          });
          check(
            "measure.length",
            "native finite edge length",
            field(length, "value"),
            10,
            0.001,
          );
          check(
            "measure.length",
            "length units are mm",
            field(length, "units"),
            "mm",
          );
          validated("measure.length");
        },
      );
      await runCase(
        "native-angle-and-distance-modes",
        ["measure.angle", "entity.find", "measure.distance"],
        async () => {
          const angle = await cad("measure.angle", {
            a: "X",
            b: "Y",
            units: "deg",
          });
          check(
            "measure.angle",
            "Fusion angle between root X and Y axes",
            field(angle, "value"),
            90,
            0.001,
          );
          check(
            "measure.angle",
            "angle units are degrees",
            field(angle, "units"),
            "deg",
          );
          validated("measure.angle");
          const bottom = await cad("entity.find", {
            kind: "face",
            filters: {
              geometry: "plane",
              axis: [0, 0, 1],
              position: ["0 mm", "0 mm", "0 mm"],
            },
            unique: true,
          });
          check(
            "entity.find",
            "bottom planar face resolved",
            field(bottom, "kind"),
            "face",
          );
          const top = await cad("entity.find", {
            kind: "face",
            filters: {
              geometry: "plane",
              axis: [0, 0, 1],
              position: ["0 mm", "0 mm", "30 mm"],
            },
            unique: true,
          });
          check(
            "entity.find",
            "top planar face resolved",
            field(top, "kind"),
            "face",
          );
          validated("entity.find", true);
          const minimum = await cad("measure.distance", {
            a: bottom,
            b: top,
            mode: "minimum",
            units: "mm",
          });
          check(
            "measure.distance",
            "minimum distance between parallel box faces",
            field(minimum, "value"),
            30,
            0.001,
          );
          const projected = await cad("measure.distance", {
            a: ["1 mm", "2 mm", "0 mm"],
            b: ["4 mm", "6 mm", "0 mm"],
            mode: "projected",
            direction: [0, 1, 0],
            space: "component local",
            units: "mm",
          });
          check(
            "measure.distance",
            "unsigned Y-projected point separation",
            field(projected, "value"),
            4,
            0.001,
          );
          const axial = await cad("measure.distance", {
            a: ["4 mm", "6 mm", "0 mm"],
            b: ["1 mm", "2 mm", "0 mm"],
            mode: "axial",
            direction: [1, 0, 0],
            space: "component local",
            units: "mm",
          });
          check(
            "measure.distance",
            "signed reversed X-axial separation",
            field(axial, "value"),
            -3,
            0.001,
          );
          validated("measure.distance", true);
        },
      );
      await runCase(
        "declared-analytic-draft-region-corridor-and-wall-map",
        [
          "measure.draft",
          "measure.region",
          "measure.corridor",
          "measure.wall-map",
        ],
        async () => {
          const radians = (5 * Math.PI) / 180;
          const draft = await cad("measure.draft", {
            schemaVersion: 1,
            faces: [
              {
                name: "five-degree-wall",
                point: ["0 mm", "0 mm", "0 mm"],
                normal: [Math.cos(radians), 0, Math.sin(radians)],
              },
              {
                name: "zero-draft-wall",
                point: ["0 mm", "0 mm", "0 mm"],
                normal: [1, 0, 0],
              },
            ],
            pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
            minDraft: "4 deg",
            pullWallWindow: "10 deg",
          });
          check(
            "measure.draft",
            "five-degree sample is preserved",
            field(draft, "draftMap", 0, "signedDraft"),
            5,
            1e-6,
          );
          check(
            "measure.draft",
            "zero-draft pull wall is flagged",
            field(draft, "draftMap", 1, "draftViolation"),
            true,
          );
          check(
            "measure.draft",
            "analytic violation count",
            field(draft, "violationCount"),
            1,
          );
          check(
            "measure.draft",
            "demoldability summary reflects draft violation",
            field(draft, "demoldableByDraft"),
            false,
          );
          validated("measure.draft");
          const region = await cad("measure.region", {
            schemaVersion: 1,
            region: {
              type: "box",
              min: ["0 mm", "0 mm", "0 mm"],
              max: ["10 mm", "10 mm", "10 mm"],
            },
            occupants: [
              {
                name: "inside-sphere",
                point: ["5 mm", "5 mm", "5 mm"],
                radius: "2 mm",
              },
              {
                name: "outside-sphere",
                point: ["12 mm", "5 mm", "5 mm"],
                radius: "1 mm",
              },
            ],
            sections: [{ z: "5 mm" }],
            samplingBudget: 20000,
          });
          check(
            "measure.region",
            "occupant count",
            field(region, "occupantCount"),
            2,
          );
          check(
            "measure.region",
            "only the centered sphere is inside the box",
            field(region, "occupiedCount"),
            1,
          );
          check(
            "measure.region",
            "outside signed distance is −0.2 cm",
            field(region, "occupancy", 1, "signedDistance"),
            -0.2,
            1e-9,
          );
          check(
            "measure.region",
            "section includes the in-box sphere",
            field(region, "sections", 0, "occupantCount"),
            1,
          );
          check(
            "measure.region",
            "deterministic section area estimates one radius-0.2 cm disk",
            number(field(region, "sections", 0, "occupiedUnionArea")) > 0.1 &&
              number(field(region, "sections", 0, "occupiedUnionArea")) < 0.15,
            true,
          );
          validated("measure.region");
          const corridor = await cad("measure.corridor", {
            schemaVersion: 1,
            path: [
              ["0 mm", "0 mm", "0 mm"],
              ["20 mm", "0 mm", "0 mm"],
            ],
            radius: "2 mm",
            obstacles: [
              { name: "near", point: ["3 mm", "0 mm", "0 mm"] },
              { name: "clear", point: ["10 mm", "5 mm", "0 mm"] },
            ],
            minimumClearance: "1.5 mm",
            sections: [{ station: "10 mm" }],
          });
          check(
            "measure.corridor",
            "centerline arc length in cm",
            field(corridor, "arcLength"),
            2,
            1e-9,
          );
          check(
            "measure.corridor",
            "one obstacle intrudes minimum clearance",
            field(corridor, "intrusions"),
            1,
          );
          check(
            "measure.corridor",
            "near-obstacle clearance in cm",
            field(corridor, "occupancy", 0, "clearance"),
            0.1,
            1e-9,
          );
          check(
            "measure.corridor",
            "clear obstacle is not an intrusion",
            field(corridor, "occupancy", 1, "intrudes"),
            false,
          );
          check(
            "measure.corridor",
            "section position at 10 mm station in cm",
            field(corridor, "sections", 0, "position", 0),
            1,
            1e-9,
          );
          validated("measure.corridor");
          const wall = await cad("measure.wall-map", {
            schemaVersion: 1,
            samples: [
              {
                name: "solid",
                point: ["0 mm", "0 mm", "0 mm"],
                thickness: "2 mm",
                continuity: "solid",
              },
              {
                name: "thin",
                point: ["0 mm", "0 mm", "0 mm"],
                thickness: "0.5 mm",
                continuity: "solid",
              },
              {
                name: "void-backed",
                point: ["0 mm", "0 mm", "0 mm"],
                thickness: "8 mm",
                continuity: "void",
              },
            ],
            minThickness: "1 mm",
            maxThickness: "4 mm",
          });
          check(
            "measure.wall-map",
            "three declared wall samples returned",
            field(wall, "wallMap", "length"),
            3,
          );
          check(
            "measure.wall-map",
            "one solid sample is below the minimum thickness",
            field(wall, "thinWallViolations", "length"),
            1,
          );
          check(
            "measure.wall-map",
            "void-backed sample is reported separately",
            field(wall, "voidBackedSamples", "length"),
            1,
          );
          check(
            "measure.wall-map",
            "void-backed sample is not treated as thick material",
            field(wall, "thickWallViolations", "length"),
            0,
          );
          check(
            "measure.wall-map",
            "solid material continuity is explicit",
            field(wall, "materialContinuityChecked"),
            true,
          );
          validated("measure.wall-map");
        },
      );
      await runCase(
        "analytic-cam-profile-and-limit-evaluation",
        ["cam.profile", "cam.evaluate"],
        async () => {
          const rise = { law: "halfCosine", lift: "10 mm", angle: "240 deg" };
          const profile = await cad("cam.profile", {
            schemaVersion: 1,
            frame: "component",
            baseRadius: "15 mm",
            rollerRadius: "5 mm",
            rise,
            followerLine: [0, 1, 0],
            phase: "0 deg",
            direction: "ccw",
          });
          check(
            "cam.profile",
            "normal-offset working profile contains 2001 native-frame samples",
            field(profile, "pitchProfile", "length"),
            2001,
          );
          check(
            "cam.profile",
            "pitch-profile starts at the 15 mm base radius",
            field(profile, "pitchProfile", 0, 0),
            15,
            1e-8,
          );
          check(
            "cam.profile",
            "roller working profile returns the declared normal offset",
            field(profile, "normalOffset", "value"),
            5,
            1e-8,
          );
          check(
            "cam.profile",
            "release remains explicitly unresolved for rise-only input",
            values(field(profile, "unresolvedIntervals")).some(
              (item) => field(item, "interval") === "release",
            ),
            true,
          );
          validated("cam.profile");
          const evaluated = await cad("cam.evaluate", {
            schemaVersion: 1,
            frame: "component",
            baseRadius: "15 mm",
            rollerRadius: "5 mm",
            rise,
            minimumCurvatureRadius: "0.1 mm",
            maximumPressureAngle: "89 deg",
          });
          check(
            "cam.evaluate",
            "curvature and pressure-angle limits both pass",
            values(field(evaluated, "checks")).every(
              (item) => field(item, "status") === "pass",
            ),
            true,
          );
          check(
            "cam.evaluate",
            "maximum pressure angle is within the declared 89 deg limit",
            number(field(evaluated, "maxPressureAngle", "value")) <= 89,
            true,
          );
          check(
            "cam.evaluate",
            "minimum pitch curvature meets the declared 0.1 mm limit",
            number(field(evaluated, "minPitchCurvatureRadius", "value")) >= 0.1,
            true,
          );
          validated("cam.evaluate");
        },
        false,
      );
      await runCase(
        "explicit-cam-cycle-resolution",
        ["cam.cycle-check"],
        async () => {
          const cycle = await cad("cam.cycle-check", {
            schemaVersion: 1,
            frame: "component",
            rise: { law: "halfCosine", lift: "10 mm", angle: "240 deg" },
            dwell: "0 deg",
            returnLaw: "spring-return",
            followerCoupling: "spring-return",
          });
          check(
            "cam.cycle-check",
            "explicit rise/dwell/release intervals resolve",
            values(field(cycle, "resolvedIntervals")).join(","),
            "rise,dwell,release",
          );
          check(
            "cam.cycle-check",
            "cycle status passes after intervals are declared",
            field(cycle, "cycleStatus"),
            "pass",
          );
          check(
            "cam.cycle-check",
            "no declared interval remains unresolved",
            field(cycle, "unresolvedIntervals", "length"),
            0,
          );
          check(
            "cam.cycle-check",
            "drop-edge dynamics remain explicitly blocked",
            field(cycle, "dropEdgeDynamics"),
            "blocked (no proper definition or evidence)",
          );
          validated("cam.cycle-check");
        },
        false,
      );
      await runCase(
        "assembly-sequence-dependency-and-service-order",
        ["assembly.sequence"],
        async () => {
          const sequence = await cad("assembly.sequence", {
            schemaVersion: 1,
            parts: ["base", "connector", "shaft", "housing"],
            dependencies: [
              ["base", "connector"],
              ["connector", "shaft"],
              ["shaft", "housing"],
            ],
            removedParts: ["connector"],
            disconnectedMedia: [
              { name: "flexible-wire", connects: ["connector", "shaft"] },
            ],
            serviceStates: [
              {
                part: "connector",
                requires: [{ media: "flexible-wire", state: "disconnected" }],
              },
            ],
            phases: [
              { name: "foundation", parts: ["base", "connector"] },
              { name: "drive", parts: ["shaft", "housing"] },
            ],
          });
          check(
            "assembly.sequence",
            "topological assembly order",
            values(field(sequence, "order")).join(","),
            "base,connector,shaft,housing",
          );
          check(
            "assembly.sequence",
            "disassembly reverses the dependency order",
            values(field(sequence, "disassemblyOrder")).join(","),
            "housing,shaft,connector,base",
          );
          check(
            "assembly.sequence",
            "removed connector identifies its downstream blocker",
            values(field(sequence, "removals", 0, "removeBlockers")).join(","),
            "shaft",
          );
          check(
            "assembly.sequence",
            "flexible cable is a disconnection prerequisite, never rigidized",
            field(sequence, "mediaRigidized"),
            false,
          );
          check(
            "assembly.sequence",
            "service prerequisites are retained",
            field(sequence, "removals", 0, "servicePrerequisites", "length"),
            1,
          );
          check(
            "assembly.sequence",
            "part phase is retained",
            field(sequence, "phaseAssignments", "base"),
            "foundation",
          );
          validated("assembly.sequence");
        },
        false,
      );
      await runCase(
        "sampled-service-withdrawal-clearance",
        ["service.path-check"],
        async () => {
          const pathCheck = await cad("service.path-check", {
            schemaVersion: 1,
            part: {
              name: "bracket",
              outline: [
                ["-10 mm", "0 mm"],
                ["10 mm", "0 mm"],
                ["10 mm", "20 mm"],
                ["-10 mm", "20 mm"],
              ],
            },
            direction: [0, 1],
            distance: "30 mm",
            minimumClearance: "4 mm",
            samples: 6,
            obstacles: [
              {
                name: "wall",
                outline: [
                  ["15 mm", "0 mm"],
                  ["30 mm", "0 mm"],
                  ["30 mm", "50 mm"],
                  ["15 mm", "50 mm"],
                ],
              },
            ],
          });
          check(
            "service.path-check",
            "sampled withdrawal is feasible with 4 mm minimum",
            field(pathCheck, "feasible"),
            true,
          );
          check(
            "service.path-check",
            "the declared wall is not a blocker",
            field(pathCheck, "blockers", "length"),
            0,
          );
          check(
            "service.path-check",
            "sampled minimum wall clearance in cm",
            field(pathCheck, "minClearance"),
            0.5,
            1e-9,
          );
          check(
            "service.path-check",
            "swept bounds include translated part endpoint",
            field(pathCheck, "sweptBounds", "max", 1),
            5,
            1e-9,
          );
          validated("service.path-check");
        },
        false,
      );
      await runCase(
        "sampled-native-solid-motion-check",
        ["assembly.motion_check"],
        async () => {
          const obstacle = field(
            await cad("shape.box", {
              name: "MotionObstacle",
              width: "1 mm",
              depth: "1 mm",
              height: "1 mm",
            }),
            "bodies",
            0,
          );
          validated("shape.box");
          const motion = await cad("assembly.motion_check", {
            moving: body,
            obstacles: [obstacle],
            minimum: "1 mm",
            translations: [
              ["0 mm", "0 mm", "0 mm"],
              ["0 mm", "0 mm", "40 mm"],
            ],
          });
          check(
            "assembly.motion_check",
            "two independently sampled translations are returned",
            field(motion, "samples", "length"),
            2,
          );
          check(
            "assembly.motion_check",
            "initial pose detects positive-volume interference",
            field(motion, "samples", 0, "checks", 0, "interferes"),
            true,
          );
          check(
            "assembly.motion_check",
            "40 mm Z translation clears the obstacle",
            field(motion, "samples", 1, "checks", 0, "clearancePassed"),
            true,
          );
          check(
            "assembly.motion_check",
            "motion output does not claim continuous collision proof",
            field(motion, "continuousMotionVerified"),
            false,
          );
          check(
            "assembly.motion_check",
            "temporary samples do not change the live occurrence transform",
            field(motion, "samples", 1, "translation", "xyz", 2),
            40,
            1e-9,
          );
          validated("assembly.motion_check");
        },
      );
      await runCase(
        "declared-bounds-motion-envelope",
        ["motion.envelope"],
        async () => {
          const envelope = await cad("motion.envelope", {
            schemaVersion: 1,
            frame: "component",
            motion: {
              type: "translation",
              axis: [1, 0, 0],
              from: "0 mm",
              to: "20 mm",
            },
            bounds: {
              min: ["0 mm", "0 mm", "0 mm"],
              max: ["10 mm", "20 mm", "30 mm"],
            },
            samples: 3,
            representation: "conservative",
          });
          check(
            "motion.envelope",
            "translation envelope uses the conservative representation",
            field(envelope, "representation"),
            "conservative",
          );
          check(
            "motion.envelope",
            "three requested positions are sampled",
            field(envelope, "sampleCount"),
            3,
          );
          check(
            "motion.envelope",
            "conservative swept bounds extend to x=3 cm",
            field(envelope, "conservativeEnvelope", "max", 0),
            3,
            1e-9,
          );
          check(
            "motion.envelope",
            "unmoved extents remain y=0..2 cm and z=0..3 cm",
            field(envelope, "conservativeEnvelope", "max", 1) +
              "|" +
              field(envelope, "conservativeEnvelope", "max", 2),
            "2|3",
          );
          check(
            "motion.envelope",
            "AABB envelope is not misreported as continuous body proof",
            field(envelope, "continuousVerified"),
            false,
          );
          validated("motion.envelope");
        },
        false,
      );
      await runCase(
        "native-clearance-grid-expected-contact",
        ["clearance.grid"],
        async () => {
          const left = await cad("component.create", {
            name: "GridLeft",
            placement: { translation: ["0 mm", "0 mm", "0 mm"] },
          });
          const right = await cad("component.create", {
            name: "GridRight",
            placement: { translation: ["12 mm", "0 mm", "0 mm"] },
          });
          validated("component.create", true);
          const leftBox = await cad(
            "shape.box",
            {
              name: "GridLeftBody",
              width: "10 mm",
              depth: "10 mm",
              height: "10 mm",
            },
            true,
            "GridLeft",
          );
          const rightBox = await cad(
            "shape.box",
            {
              name: "GridRightBody",
              width: "10 mm",
              depth: "10 mm",
              height: "10 mm",
            },
            true,
            "GridRight",
          );
          validated("shape.box", true);
          const a = {
            ...record(field(leftBox, "bodies", 0)),
            occurrence: field(left, "occurrence"),
          };
          const b = {
            ...record(field(rightBox, "bodies", 0)),
            occurrence: field(right, "occurrence"),
          };
          const grid = await cad(
            "clearance.grid",
            {
              schemaVersion: 1,
              frame: "component",
              pairs: [{ a, b }],
              minimum: "1 mm",
              volumeTolerance: "0 mm3",
              budget: { maxChecks: 1 },
              expectedContacts: [
                {
                  a,
                  b,
                  cause: "declared two-millimeter assembly gap",
                  clearance: { min: "1.9 mm", max: "2.1 mm" },
                },
              ],
            },
            false,
          );
          check(
            "clearance.grid",
            "one explicit body-instance pair is measured",
            field(grid, "coverage", "total"),
            1,
          );
          check(
            "clearance.grid",
            "expected contact/readback passes its independent range",
            field(grid, "results", 0, "expected") &&
              field(grid, "results", 0, "passed") &&
              field(grid, "results", 0, "status") === "tested",
            true,
          );
          check(
            "clearance.grid",
            "native unsigned minimum gap is 2 mm",
            field(grid, "results", 0, "distance", "value"),
            2,
            0.001,
          );
          check(
            "clearance.grid",
            "separated bodies have zero positive-volume interference",
            field(grid, "results", 0, "interferes"),
            false,
          );
          check(
            "clearance.grid",
            "grid reports sampled, not continuous, coverage",
            field(grid, "coverage", "continuousVerified"),
            false,
          );
          validated("clearance.grid");
        },
      );
      await runCase(
        "declared-connector-keying-and-keepout",
        ["connector.mate-check", "keepout.check"],
        async () => {
          const mates = await cad("connector.mate-check", {
            schemaVersion: 1,
            connectors: [
              {
                name: "POWER_M",
                gender: "male",
                pinCount: 4,
                key: "power-key",
              },
              {
                name: "POWER_F",
                gender: "female",
                pinCount: 4,
                key: "power-key",
              },
              {
                name: "DATA_F",
                gender: "female",
                pinCount: 4,
                key: "data-key",
              },
            ],
            intendedPairs: [["POWER_M", "POWER_F"]],
            forbiddenPairs: [["POWER_M", "DATA_F"]],
          });
          check(
            "connector.mate-check",
            "intended complementary keyed pair mates",
            field(mates, "intended", 0, "mates"),
            true,
          );
          check(
            "connector.mate-check",
            "different forbidden key cannot reach seating orientation",
            field(mates, "forbidden", 0, "canReachSeating"),
            false,
          );
          check(
            "connector.mate-check",
            "declared poka-yoke set passes",
            field(mates, "passed"),
            true,
          );
          validated("connector.mate-check");
          const keepout = await cad("keepout.check", {
            schemaVersion: 1,
            board: {
              outline: [
                ["0 mm", "0 mm"],
                ["20 mm", "0 mm"],
                ["20 mm", "20 mm"],
                ["0 mm", "20 mm"],
              ],
            },
            keepouts: [
              {
                name: "K1",
                outline: [
                  ["2 mm", "2 mm"],
                  ["8 mm", "2 mm"],
                  ["8 mm", "8 mm"],
                  ["2 mm", "8 mm"],
                ],
              },
            ],
          });
          check(
            "keepout.check",
            "fully contained copper keepout passes board geometry check",
            field(keepout, "passed"),
            true,
          );
          check(
            "keepout.check",
            "no declared keepout violations are present",
            field(keepout, "violations", "length"),
            0,
          );
          validated("keepout.check");
        },
        false,
      );
      await runCase(
        "declared-pcb-packing-port-and-undercut",
        ["pack.cross-section", "port.define", "undercut.check"],
        async () => {
          const pack = await cad("pack.cross-section", {
            schemaVersion: 1,
            cavity: [
              ["0 mm", "0 mm"],
              ["10 mm", "0 mm"],
              ["10 mm", "10 mm"],
              ["0 mm", "10 mm"],
            ],
            items: [{ center: ["5 mm", "5 mm", "0 mm"], radius: "2 mm" }],
            reserve: 0.3,
            samplingBudget: 10000,
          });
          check(
            "pack.cross-section",
            "centered circular part fits the declared square cavity",
            field(pack, "passed"),
            true,
          );
          check(
            "pack.cross-section",
            "reserve denominator is the cavity area",
            field(pack, "reserve", "denominator"),
            "cavity area",
          );
          check(
            "pack.cross-section",
            "grid union area approximates the radius-2 mm disk",
            number(field(pack, "occupiedUnionArea")) > 0.12 &&
              number(field(pack, "occupiedUnionArea")) < 0.13,
            true,
          );
          check(
            "pack.cross-section",
            "required 30 percent reserve remains available",
            number(field(pack, "reserve", "actual")) >= 0.3,
            true,
          );
          validated("pack.cross-section");
          const port = await cad("port.define", {
            schemaVersion: 1,
            name: "AnalyticsPort",
            frame: {
              origin: ["1 mm", "2 mm", "3 mm"],
              normal: [0, 0, 2],
              pin1: ["3 mm", "2 mm", "3 mm"],
            },
            key: "PWR-A",
            matingStroke: "5 mm",
            supportZones: [{ name: "body-support" }],
          });
          check(
            "port.define",
            "caller port name and key are preserved",
            field(port, "name") + "|" + field(port, "key"),
            "AnalyticsPort|PWR-A",
          );
          [0.1, 0.2, 0.3].forEach((value, index) =>
            check(
              "port.define",
              "origin cm coordinate " + index,
              field(port, "origin", index),
              value,
              1e-9,
            ),
          );
          [0, 0, 1].forEach((value, index) =>
            check(
              "port.define",
              "normalized direction component " + index,
              field(port, "normal", index),
              value,
              1e-9,
            ),
          );
          check(
            "port.define",
            "mating stroke is returned in centimeters",
            field(port, "matingStroke"),
            0.5,
            1e-9,
          );
          validated("port.define");
          const undercut = await cad("undercut.check", {
            schemaVersion: 1,
            faces: [
              {
                name: "draftable-side",
                point: ["0 mm", "0 mm", "5 mm"],
                normal: [0, 0, 1],
              },
            ],
            pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
            undercutThreshold: "3 deg",
          });
          check(
            "undercut.check",
            "face normal aligned with pull has no undercut",
            field(undercut, "passed"),
            true,
          );
          check(
            "undercut.check",
            "no undercut records are returned",
            field(undercut, "undercutCount"),
            0,
          );
          check(
            "undercut.check",
            "directional method does not claim broader draft certification",
            field(undercut, "demoldableIsNotDraftAlone"),
            true,
          );
          validated("undercut.check");
        },
        false,
      );
      await runCase(
        "root-body-context-audit-with-independent-datum",
        ["frame.context_audit"],
        async () => {
          const audit = await cad("frame.context_audit", {
            ref: body,
            sourceId: "measurement-block-v1",
            instance: [],
            datumToRoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            datumSource: { kind: "independent-analytic-placement", version: 1 },
          });
          check(
            "frame.context_audit",
            "root body datum, native-chain and proxy transforms agree",
            field(audit, "status"),
            "pass",
          );
          check(
            "frame.context_audit",
            "no frame or sampled point mismatch is reported",
            field(audit, "failures", "length"),
            0,
          );
          check(
            "frame.context_audit",
            "independent root BRep vertex witnesses were compared",
            number(field(audit, "witnessCount")) > 0,
            true,
          );
          check(
            "frame.context_audit",
            "sampled witness check does not claim exact BRep equivalence",
            field(audit, "exactBRepEquivalence"),
            false,
          );
          check(
            "frame.context_audit",
            "caller-owned source identity is returned",
            field(audit, "observation", "source", "id"),
            "measurement-block-v1",
          );
          check(
            "frame.context_audit",
            "independent provenance is returned",
            field(audit, "observation", "datumSource", "kind") +
              "|" +
              field(audit, "observation", "datumSource", "version"),
            "independent-analytic-placement|1",
          );
          validated("frame.context_audit");
        },
        false,
      );
      await runCase(
        "declared-seal-profile-gland-evaluation-and-dock-order",
        ["seal.profile", "seal.gland", "seal.evaluate", "dock.sequence-check"],
        async () => {
          const profile = await cad("seal.profile", {
            schemaVersion: 1,
            frame: "component",
            layout: "gasket",
            crossSection: {
              shape: "custom",
              points: [
                ["0 mm", "0 mm"],
                ["2 mm", "0 mm"],
                ["2 mm", "1.5 mm"],
                ["0 mm", "1.5 mm"],
                ["0 mm", "0 mm"],
              ],
            },
            path: { closed: true, length: "80 mm" },
          });
          check(
            "seal.profile",
            "closed custom gasket is not mislabeled as a plain O-ring",
            field(profile, "crossSection", "isPlainORing"),
            false,
          );
          check(
            "seal.profile",
            "closed cross-section and sweep path are explicitly observed",
            field(profile, "crossSection", "continuity", "closed") &&
              field(profile, "envelope", "closed"),
            true,
          );
          check(
            "seal.profile",
            "declared gasket path length is 80 mm",
            field(profile, "envelope", "length", "value"),
            80,
            1e-9,
          );
          validated("seal.profile");
          const gland = await cad("seal.gland", {
            schemaVersion: 1,
            frame: "component",
            type: "radial",
            oRing: { id: "10 mm", cs: "2 mm" },
            squeeze: 0.15,
            hardStop: { clearance: "0.05 mm" },
          });
          check(
            "seal.gland",
            "nominal target squeeze is 15 percent",
            field(gland, "squeeze", "nominal"),
            0.15,
            1e-9,
          );
          check(
            "seal.gland",
            "default width targets 75 percent nominal fill",
            field(gland, "fill", "nominal"),
            0.75,
            1e-9,
          );
          check(
            "seal.gland",
            "squeeze, fill and hard-stop checks pass",
            values(field(gland, "checks")).every(
              (item) => field(item, "status") === "pass",
            ),
            true,
          );
          check(
            "seal.gland",
            "positive metallic hard stop is reported engaged",
            field(gland, "hardStop", "engaged"),
            true,
          );
          validated("seal.gland");
          const evaluated = await cad("seal.evaluate", {
            schemaVersion: 1,
            frame: "component",
            type: "radial",
            oRing: { id: "10 mm", cs: "2 mm" },
            gland: { depth: "1.7 mm", width: "2.4 mm" },
            gap: "0.1 mm",
            extrusionGapLimit: "0.2 mm",
            hardStop: { clearance: "0.05 mm" },
          });
          check(
            "seal.evaluate",
            "installed squeeze equals 15 percent",
            field(evaluated, "squeeze"),
            0.15,
            1e-9,
          );
          check(
            "seal.evaluate",
            "explicit extrusion-gap limit passes",
            field(
              values(field(evaluated, "checks")).find(
                (item) => field(item, "check") === "extrusion-gap",
              ),
              "status",
            ),
            "pass",
          );
          check(
            "seal.evaluate",
            "gland-volume and hard-stop checks pass",
            values(field(evaluated, "checks"))
              .filter((item) =>
                ["gland-volume", "hard-stop"].includes(
                  text(field(item, "check")),
                ),
              )
              .every((item) => field(item, "status") === "pass"),
            true,
          );
          check(
            "seal.evaluate",
            "evaluation remains geometric, not a sealing certification",
            text(field(evaluated, "installedEnvelope")).includes(
              "no material/sealing solution",
            ),
            true,
          );
          validated("seal.evaluate");
          const dock = await cad("dock.sequence-check", {
            schemaVersion: 1,
            frame: "component",
            connect: [
              { event: "lead-in", at: "0 mm" },
              { event: "locator-engage", at: "2 mm" },
              { event: "seal-contact", at: "4 mm" },
              { event: "valve-open", at: "4.6 mm" },
              { event: "both-valve-open", at: "5 mm" },
            ],
            disconnect: [
              { event: "valve-close", at: "0 mm" },
              { event: "both-valves-closed", at: "0.2 mm" },
              { event: "seal-contact", at: "1 mm" },
              { event: "locator-release", at: "2 mm" },
              { event: "lead-out", at: "3 mm" },
            ],
            axialTolerance: "0.05 mm",
            float: "0.1 mm",
            locatorTolerance: "0.05 mm",
            minimumSealBeforeOpen: "0.4 mm",
          });
          check(
            "dock.sequence-check",
            "worst-case seal-before-open margin meets 0.4 mm",
            field(dock, "worstCaseMargin", "value"),
            0.4,
            1e-9,
          );
          check(
            "dock.sequence-check",
            "second valve-open evidence is present",
            field(
              values(field(dock, "checks")).find(
                (item) => field(item, "check") === "both-valve-open",
              ),
              "status",
            ),
            "pass",
          );
          check(
            "dock.sequence-check",
            "disconnect retains the seal until after valve closure",
            field(
              values(field(dock, "checks")).find(
                (item) => field(item, "check") === "seal-after-close",
              ),
              "margin",
              "value",
            ),
            1,
            1e-9,
          );
          validated("dock.sequence-check");
        },
        false,
      );
      await runCase(
        "sampled-helix-recipe-without-native-coil",
        ["shape.helix", "snapshot"],
        async () => {
          const before = await cad("snapshot", {});
          validated("snapshot");
          const helix = await cad("shape.helix", {
            schemaVersion: 1,
            frame: "component",
            radius: "4 mm",
            pitch: "5.75 mm",
            turns: 8,
            hand: "right",
            startPhase: "0 deg",
            tolerance: "0.01 mm",
          });
          check(
            "shape.helix",
            "generated helix is explicitly a sampled recipe",
            field(helix, "representation"),
            "recipe",
          );
          check(
            "shape.helix",
            "recipe does not claim a native Coil",
            field(helix, "nativeCoil"),
            false,
          );
          check(
            "shape.helix",
            "sample count matches the returned point count",
            field(helix, "sampleCount"),
            field(helix, "samplePoints", "length"),
          );
          const first = field(helix, "samplePoints", 0);
          const firstRadius = Math.hypot(
            number(field(first, 0, "value")),
            number(field(first, 1, "value")),
          );
          check(
            "shape.helix",
            "first sample lies at the declared 4 mm radius",
            firstRadius,
            4,
            1e-8,
          );
          check(
            "shape.helix",
            "last sample reaches the declared 46 mm axial height",
            field(values(field(helix, "samplePoints")).at(-1), 2, "value"),
            46,
            1e-8,
          );
          validated("shape.helix");
          const after = await cad("snapshot", {});
          check(
            "snapshot",
            "recipe-only helix creates no persistent BRep body",
            field(after, "counts", "bodyDefinitions"),
            field(before, "counts", "bodyDefinitions"),
          );
          validated("snapshot");
        },
        false,
      );
      await runCase(
        "declared-optical-frustum-coverage-and-occlusion",
        [
          "optics.frustum",
          "optics.coverage",
          "optics.occlusion",
          "sensor.alignment-check",
        ],
        async () => {
          const frustum = await cad("optics.frustum", {
            schemaVersion: 1,
            pupil: {
              origin: ["0 mm", "0 mm", "0 mm"],
              direction: [0, 0, 1],
              up: [0, 1, 0],
            },
            fov: { horizontal: "60 deg", vertical: "40 deg" },
            ranges: { near: "10 mm", far: "100 mm" },
            window: { distance: "50 mm", width: "20 mm", height: "20 mm" },
          });
          check(
            "optics.frustum",
            "declared rectangular aperture limits the frustum",
            field(frustum, "windowLimited"),
            true,
          );
          check(
            "optics.frustum",
            "window-limited horizontal half-angle is atan(0.2)",
            field(frustum, "effectiveHalfAngles", "horizontal"),
            Math.atan(0.2),
            1e-9,
          );
          check(
            "optics.frustum",
            "window-limited vertical half-angle is atan(0.2)",
            field(frustum, "effectiveHalfAngles", "vertical"),
            Math.atan(0.2),
            1e-9,
          );
          check(
            "optics.frustum",
            "near/far clip distances return in centimeters",
            field(frustum, "ranges", "near") +
              "|" +
              field(frustum, "ranges", "far"),
            "1|10",
          );
          check(
            "optics.frustum",
            "clipped far half-width returns 2 mm in cm",
            field(frustum, "clippedCorners", "far", 0, 0),
            0.2,
            1e-9,
          );
          validated("optics.frustum");
          const coverage = await cad("optics.coverage", {
            schemaVersion: 1,
            samplingBudget: 400,
            sensors: [
              {
                name: "overhead",
                pupil: {
                  origin: ["0 mm", "0 mm", "30 mm"],
                  direction: [0, 0, -1],
                  up: [0, 1, 0],
                },
                fov: { horizontal: "90 deg", vertical: "90 deg" },
                ranges: { near: "1 mm", far: "100 mm" },
              },
            ],
            targets: [
              {
                name: "board",
                origin: ["0 mm", "0 mm", "0 mm"],
                normal: [0, 0, 1],
                u: [1, 0, 0],
                outline: [
                  ["-10 mm", "-10 mm"],
                  ["10 mm", "-10 mm"],
                  ["10 mm", "10 mm"],
                  ["-10 mm", "10 mm"],
                ],
              },
            ],
          });
          check(
            "optics.coverage",
            "one declared sensor covers the full small planar target",
            field(coverage, "targets", 0, "coveredFraction"),
            1,
          );
          check(
            "optics.coverage",
            "grid-estimated target area is 4 cm2",
            field(coverage, "targets", 0, "outlineArea"),
            4,
            1e-9,
          );
          check(
            "optics.coverage",
            "all 400 target-grid samples are classified",
            field(coverage, "targets", 0, "samples"),
            400,
          );
          check(
            "optics.coverage",
            "coverage output remains explicitly deterministic-grid based",
            field(coverage, "samplingBudget"),
            400,
          );
          validated("optics.coverage");
          const occlusion = await cad("optics.occlusion", {
            schemaVersion: 1,
            pupil: { origin: ["0 mm", "0 mm", "0 mm"] },
            rays: [
              { target: ["0 mm", "0 mm", "50 mm"] },
              { target: ["10 mm", "0 mm", "50 mm"] },
            ],
            obstacles: [
              {
                name: "baffle",
                kind: "baffle",
                shape: {
                  type: "disk",
                  origin: ["0 mm", "0 mm", "25 mm"],
                  normal: [0, 0, 1],
                  radius: "4 mm",
                },
              },
              {
                name: "declared-window",
                kind: "window",
                transmittance: 0.9,
                shape: {
                  type: "disk",
                  origin: ["5 mm", "0 mm", "25 mm"],
                  normal: [0, 0, 1],
                  radius: "4 mm",
                },
              },
            ],
          });
          check(
            "optics.occlusion",
            "center ray is blocked by the opaque baffle",
            field(occlusion, "rays", 0, "result"),
            "blocked",
          );
          check(
            "optics.occlusion",
            "off-axis ray passes the declared transparent window",
            field(occlusion, "rays", 1, "result"),
            "window",
          );
          check(
            "optics.occlusion",
            "window transmittance is preserved",
            field(occlusion, "rays", 1, "transmittance"),
            0.9,
          );
          check(
            "optics.occlusion",
            "blocked/window/clear ray counts are explicit",
            [
              field(occlusion, "blockedCount"),
              field(occlusion, "transparentCount"),
              field(occlusion, "clearCount"),
            ].join("|"),
            "1|1|0",
          );
          validated("optics.occlusion");
          const alignment = await cad("sensor.alignment-check", {
            schemaVersion: 1,
            sensor: {
              name: "sensor",
              origin: ["0 mm", "0 mm", "1 mm"],
              axis: [0, 0, 1],
            },
            reference: {
              name: "datum",
              origin: ["0 mm", "0 mm", "0 mm"],
              axis: [0, 0, 1],
            },
            limits: {
              angle: "1 deg",
              offset: "0.1 mm",
              gap: { min: "0 mm", max: "2 mm" },
            },
          });
          check(
            "sensor.alignment-check",
            "coaxial sensor axis passes declared limits",
            field(alignment, "aligned"),
            true,
          );
          check(
            "sensor.alignment-check",
            "axis angle deviation is zero",
            field(alignment, "angleDeviation"),
            0,
            1e-9,
          );
          check(
            "sensor.alignment-check",
            "lateral offset is zero",
            field(alignment, "lateralOffset"),
            0,
            1e-9,
          );
          check(
            "sensor.alignment-check",
            "axial gap returns 0.1 cm",
            field(alignment, "axialGap"),
            0.1,
            1e-9,
          );
          check(
            "sensor.alignment-check",
            "no forbidden-zone violations are returned",
            field(alignment, "violations", "length"),
            0,
          );
          validated("sensor.alignment-check");
        },
        false,
      );
      await runCase(
        "declared-fastener-bearing-mount-and-shaft-analytics",
        [
          "mount.check",
          "fastener.stack",
          "fastener.check",
          "fastener.schedule",
          "bearing.stack-check",
          "shaft.interface",
          "retention.bayonet",
          "snap.define",
          "snap.evaluate",
        ],
        async () => {
          const mount = await cad("mount.check", {
            schemaVersion: 1,
            frame: "component",
            scheme: "pin-slot",
            holes: [
              { diameter: "3 mm", clearance: "0.5 mm" },
              { diameter: "3 mm", clearance: "0.5 mm" },
            ],
            connector: { supported: true, supportPresent: true },
          });
          check(
            "mount.check",
            "pin-slot mount is not over-constrained",
            field(mount, "overConstrained"),
            false,
          );
          check(
            "mount.check",
            "declared locating and connector-support checks pass",
            values(field(mount, "checks")).every(
              (item) => field(item, "status") === "pass",
            ),
            true,
          );
          validated("mount.check");
          const stackInput = {
            schemaVersion: 1,
            frame: "component",
            screw: {
              length: "12 mm",
              threadLength: "10 mm",
              headDiameter: "6 mm",
            },
            stack: [
              { id: "bracket", thickness: "4 mm" },
              { id: "pcb", thickness: "1.6 mm" },
            ],
            receptacle: { kind: "insert", depth: "8 mm" },
            torque: "0.5 N*m",
            tool: { diameter: "5 mm" },
          };
          const stack = await cad("fastener.stack", stackInput);
          check(
            "fastener.stack",
            "result status passes for a positive engagement stack",
            field(stack, "status"),
            "pass",
          );
          check(
            "fastener.stack",
            "clamped stack length is 5.6 mm",
            field(stack, "clampedLength", "value"),
            5.6,
            1e-9,
          );
          check(
            "fastener.stack",
            "thread engagement is 4.4 mm",
            field(stack, "engagement", "value"),
            4.4,
            1e-9,
          );
          check(
            "fastener.stack",
            "torque is reported as declared, not derived",
            field(stack, "torqueStatus"),
            "declared",
          );
          check(
            "fastener.stack",
            "insert bottoming clearance is 1.6 mm",
            field(stack, "bottoming", "clearance", "value"),
            1.6,
            1e-9,
          );
          validated("fastener.stack");
          const checked = await cad("fastener.check", {
            ...stackInput,
            minimumEngagement: "4 mm",
            receptacle: { kind: "insert", depth: "8 mm" },
            tool: { diameter: "4 mm", recess: "5 mm" },
          });
          check(
            "fastener.check",
            "declared fastener checks all pass",
            values(field(checked, "checks")).every(
              (item) => field(item, "status") === "pass",
            ),
            true,
          );
          check(
            "fastener.check",
            "each requested fastener check reports pass",
            values(field(checked, "checks"))
              .filter((item) =>
                ["engagement", "bottoming", "access"].includes(
                  text(field(item, "check")),
                ),
              )
              .every((item) => field(item, "status") === "pass"),
            true,
          );
          validated("fastener.check");
          const schedule = await cad("fastener.schedule", {
            schemaVersion: 1,
            frame: "component",
            fasteners: [
              {
                id: "M3-A",
                torque: "0.5 N*m",
                process: "torque wrench",
                material: "A2-70",
                vendor: "VENDOR-A",
              },
              {
                id: "M3-B",
                torque: "0.5 N*m",
                process: "torque wrench",
                material: "A2-70",
                vendor: "VENDOR-A",
              },
            ],
          });
          check(
            "fastener.schedule",
            "two complete fasteners produce a passing schedule",
            field(schedule, "status"),
            "pass",
          );
          check(
            "fastener.schedule",
            "complete declared rows have no missing data",
            field(schedule, "missingData", "length"),
            0,
          );
          validated("fastener.schedule");
          const bearing = await cad("bearing.stack-check", {
            schemaVersion: 1,
            frame: "component",
            rings: { inner: { bore: "10 mm" }, outer: { od: "26 mm" } },
            journal: "10 mm",
            seat: "26 mm",
            shaftClearance: "0.005 mm",
            housingClearance: "0 mm",
            shoulder: { inner: true },
            arrangement: "fixed-floating",
          });
          check(
            "bearing.stack-check",
            "inner ring is the declared fixed ring",
            field(bearing, "fixedRing"),
            "inner",
          );
          check(
            "bearing.stack-check",
            "no preload is fabricated",
            field(bearing, "preload"),
            "none declared",
          );
          check(
            "bearing.stack-check",
            "fixed-floating arrangement is preserved",
            field(bearing, "arrangement"),
            "fixed-floating",
          );
          validated("bearing.stack-check");
          const shaft = await cad("shaft.interface", {
            schemaVersion: 1,
            frame: "component",
            shaft: { type: "D-flat", d: "6 mm", flat: { depth: "0.5 mm" } },
            hub: {
              bore: "6 mm",
              boreType: "D-flat",
              splitClampGap: "0.8 mm",
              shoulders: [{}],
            },
          });
          check(
            "shaft.interface",
            "matching D-flat shaft and bore mate passes",
            values(field(shaft, "checks")).every(
              (item) => field(item, "status") === "pass",
            ),
            true,
          );
          check(
            "shaft.interface",
            "D-flat mate is reported explicitly",
            values(field(shaft, "matedFeatures")).some((item) =>
              String(item).toLowerCase().includes("d-flat"),
            ),
            true,
          );
          validated("shaft.interface");
          const bayonet = await cad("retention.bayonet", {
            schemaVersion: 1,
            frame: "component",
            lugs: { count: 3, width: "4 mm", height: "2 mm" },
            stroke: "6 mm",
            rotation: "30 deg",
            capture: { depth: "1.5 mm" },
            clearances: { radial: "0.2 mm" },
          });
          check(
            "retention.bayonet",
            "captured three-lug bayonet returns the declared path",
            field(bayonet, "assemblyPath"),
            "insert -> rotate -> capture",
          );
          check(
            "retention.bayonet",
            "capture depth is 1.5 mm",
            field(
              values(field(bayonet, "checks")).find(
                (item) => field(item, "check") === "axial-capture",
              ),
              "captureDepth",
              "value",
            ),
            1.5,
            1e-9,
          );
          validated("retention.bayonet");
          const snapInput = {
            schemaVersion: 1,
            frame: "component",
            geometry: {
              length: "10 mm",
              width: "4 mm",
              thickness: "1 mm",
              engagementDepth: "0.6 mm",
              deflection: "0.6 mm",
            },
            material: {
              name: "ABS",
              modulus: "2.1 GPa",
              yieldStrength: "40 MPa",
            },
            support: { condition: "cantilever" },
          };
          const definition = await cad("snap.define", {
            ...snapInput,
            geometry: { ...record(field(snapInput, "geometry")) },
          });
          check(
            "snap.define",
            "snap definition records its cantilever geometry",
            field(definition, "shape"),
            "cantilever beam snap with rectangular section",
          );
          check(
            "snap.define",
            "material is caller-declared with no implicit default",
            field(definition, "material", "name"),
            "ABS",
          );
          validated("snap.define");
          const snap = await cad("snap.evaluate", snapInput);
          check(
            "snap.evaluate",
            "cantilever stiffness is 2.1 N/mm",
            field(snap, "stiffness", "value"),
            2.1,
            1e-6,
          );
          check(
            "snap.evaluate",
            "engagement force is 1.26 N",
            field(snap, "engagementForce", "value"),
            1.26,
            1e-6,
          );
          check(
            "snap.evaluate",
            "linear beam stress is 18.9 MPa",
            field(snap, "stress", "value"),
            18.9,
            1e-6,
          );
          check(
            "snap.evaluate",
            "declared yield-strength check passes",
            field(
              values(field(snap, "checks")).find(
                (item) => field(item, "check") === "strain",
              ),
              "status",
            ),
            "pass",
          );
          validated("snap.evaluate");
        },
        false,
      );
      await runCase(
        "declared-involute-gear-pair-check",
        ["gear.pair-check"],
        async () => {
          const external = await cad("gear.pair-check", {
            schemaVersion: 1,
            gear1: {
              module: "2 mm",
              teeth: 20,
              pressureAngle: "20 deg",
              backlashAllocation: "0.05 mm",
            },
            gear2: {
              module: "2 mm",
              teeth: 40,
              pressureAngle: "20 deg",
              toothThicknessReduction: "0.05 mm",
            },
            external: true,
            phase: 0.25,
          });
          check(
            "gear.pair-check",
            "external pair signed speed ratio is +2",
            field(external, "ratio"),
            2,
            1e-9,
          );
          check(
            "gear.pair-check",
            "external nominal center distance is 6 cm",
            field(external, "nominalCenterDistance"),
            6,
            1e-9,
          );
          check(
            "gear.pair-check",
            "external working angle is the declared 20 degrees",
            field(external, "workingAngle"),
            (20 * Math.PI) / 180,
            1e-9,
          );
          check(
            "gear.pair-check",
            "backlash sums both declared allocations in cm",
            field(external, "backlash"),
            0.01,
            1e-9,
          );
          check(
            "gear.pair-check",
            "independent tooth counts are returned",
            values(field(external, "teeth")).join(","),
            "20,40",
          );
          validated("gear.pair-check");
          const internal = await cad("gear.pair-check", {
            schemaVersion: 1,
            gear1: { module: "2 mm", teeth: 40, pressureAngle: "20 deg" },
            gear2: { module: "2 mm", teeth: 20, pressureAngle: "20 deg" },
            external: false,
            centerDistance: "20 mm",
          });
          check(
            "gear.pair-check",
            "internal pair signed speed ratio is −0.5",
            field(internal, "ratio"),
            -0.5,
            1e-9,
          );
          check(
            "gear.pair-check",
            "internal nominal center distance is 2 cm",
            field(internal, "nominalCenterDistance"),
            2,
            1e-9,
          );
          check(
            "gear.pair-check",
            "internal center input is returned as 2 cm",
            field(internal, "centerDistance"),
            2,
            1e-9,
          );
          check(
            "gear.pair-check",
            "internal working angle is derived from base diameters",
            field(internal, "workingAngle"),
            (20 * Math.PI) / 180,
            1e-9,
          );
          validated("gear.pair-check");
        },
        false,
      );
      await runCase(
        "named-datum-frame-and-root-transform",
        ["datum.frame", "datum.transform"],
        async () => {
          const input = {
            name: "AnalyticsFrame",
            origin: ["10 mm", "-20 mm", "30 mm"],
            xAxis: [1, 0, 0],
            yAxis: [0, 1, 0],
          };
          const frame = await cad("datum.frame", input);
          check(
            "datum.frame",
            "metadata frame kind is returned",
            field(frame, "kind"),
            "frame",
          );
          check(
            "datum.frame",
            "signed frame origin x is stored in cm",
            field(frame, "matrix", 3),
            1,
            1e-10,
          );
          check(
            "datum.frame",
            "signed frame origin y is stored in cm",
            field(frame, "matrix", 7),
            -2,
            1e-10,
          );
          check(
            "datum.frame",
            "frame origin z is stored in cm",
            field(frame, "matrix", 11),
            3,
            1e-10,
          );
          check(
            "datum.frame",
            "frame is explicitly a snapshot, not a native coordinate system",
            field(frame, "associativity"),
            "snapshot",
          );
          check(
            "datum.frame",
            "first metadata call creates the named frame",
            field(frame, "changed"),
            true,
          );
          validated("datum.frame");
          const reused = await cad("datum.frame", {
            ...input,
            onExisting: "reuse",
          });
          check(
            "datum.frame",
            "identical reuse is an idempotent no-op",
            field(reused, "changed"),
            false,
          );
          check(
            "datum.frame",
            "reuse returns the original frame matrix",
            values(field(reused, "matrix")).join(","),
            values(field(frame, "matrix")).join(","),
          );
          validated("datum.frame");
          const transformed = await cad("datum.transform", {
            from: "root",
            to: "root",
            points: [["10 mm", "-2 mm", "0 mm"]],
            vectors: [
              [2, 0, 0],
              [0, -1, 0],
              [0, 0, 0],
            ],
            differences: [
              { from: ["1 mm", "2 mm", "3 mm"], to: ["4 mm", "6 mm", "8 mm"] },
            ],
          });
          check(
            "datum.transform",
            "root-to-root matrix is 4×4",
            field(transformed, "matrix", "length"),
            16,
          );
          values(field(transformed, "matrix")).forEach((value, index) =>
            check(
              "datum.transform",
              "identity matrix element " + index,
              value,
              index % 5 === 0 ? 1 : 0,
              1e-10,
            ),
          );
          [1, -0.2, 0].forEach((expected, index) =>
            check(
              "datum.transform",
              "point coordinate converted to cm " + index,
              field(transformed, "points", 0, index),
              expected,
              1e-10,
            ),
          );
          [2, 0, 0].forEach((expected, index) =>
            check(
              "datum.transform",
              "non-unit vector component preserved " + index,
              field(transformed, "vectors", 0, index),
              expected,
              1e-10,
            ),
          );
          [0, 0, 0].forEach((expected, index) =>
            check(
              "datum.transform",
              "zero vector component remains zero " + index,
              field(transformed, "vectors", 2, index),
              expected,
              1e-10,
            ),
          );
          check(
            "datum.transform",
            "directed difference is to-minus-from in cm",
            values(field(transformed, "differences", 0)).join(","),
            "0.3,0.4,0.5",
            1e-10,
          );
          validated("datum.transform");
        },
        false,
      );
      await runCase(
        "native-plane-on-sketch-path-readback",
        ["sketch.create", "sketch.geometry", "datum.plane-on-path"],
        async () => {
          const sketch = await cad("sketch.create", {
            name: "AnalyticsPathSketch",
            plane: "XY",
          });
          check(
            "sketch.create",
            "native path sketch reference returned",
            field(sketch, "sketch", "kind"),
            "sketch",
          );
          validated("sketch.create");
          const geometry = await cad("sketch.geometry", {
            sketch: field(sketch, "sketch"),
            geometry: [
              {
                type: "line",
                name: "AnalyticsRail",
                start: ["0 mm", "0 mm", "0 mm"],
                end: ["40 mm", "0 mm", "0 mm"],
              },
            ],
          });
          const rail =
            values(field(geometry, "entities")).find(
              (entity) => field(entity, "name") === "AnalyticsRail",
            ) || field(geometry, "refs", "AnalyticsRail");
          check(
            "sketch.geometry",
            "one native path-curve reference returned",
            Boolean(rail),
            true,
          );
          validated("sketch.geometry");
          const section = await cad("datum.plane-on-path", {
            name: "AnalyticsPathSection",
            path: { curves: [rail], chain: "none" },
            position: { mode: "proportional", value: "0.5" },
            orientation: { direction: [0, 0, 1], frame: "root" },
            representation: "native",
          });
          check(
            "datum.plane-on-path",
            "native path plane creation passes",
            field(section, "status"),
            "pass",
          );
          check(
            "datum.plane-on-path",
            "40 mm native path length returns 4 cm",
            field(section, "pathLength"),
            4,
            1e-8,
          );
          check(
            "datum.plane-on-path",
            "path midpoint x coordinate is 2 cm",
            field(section, "expectedPoint", 0),
            2,
            1e-8,
          );
          check(
            "datum.plane-on-path",
            "plane normal aligns with path tangent",
            Math.abs(number(field(section, "normalDotTangent"))),
            1,
            1e-8,
          );
          check(
            "datum.plane-on-path",
            "plane placement residual is within kernel tolerance",
            number(field(section, "distanceResidual")) <= 1e-6,
            true,
          );
          check(
            "datum.plane-on-path",
            "orientation supplies snapshot section-frame metadata",
            field(section, "sectionFrame", "associativity"),
            "snapshot",
          );
          validated("datum.plane-on-path");
          const listed = await cad("entity.list", {
            kind: "constructionPlane",
          });
          check(
            "entity.list",
            "native named construction plane appears in entity readback",
            values(field(listed, "entities")).some(
              (entity) => field(entity, "name") === "AnalyticsPathSection",
            ),
            true,
          );
          validated("entity.list");
        },
      );
      await runCase(
        "cylindrical-tool-access-and-fixture-seating",
        ["tool.access", "fixture.access"],
        async () => {
          const access = await cad("tool.access", {
            schemaVersion: 1,
            tool: { diameter: "6 mm", length: "40 mm" },
            target: {
              origin: ["0 mm", "0 mm", "0 mm"],
              axis: [0, 0, 1],
              engagementDepth: "4 mm",
            },
            entry: { origin: ["0 mm", "0 mm", "30 mm"], direction: [0, 0, -1] },
            samples: 5,
          });
          check(
            "tool.access",
            "tool reaches the engagement point",
            field(access, "reachable"),
            true,
          );
          check(
            "tool.access",
            "approach axis is aligned",
            field(access, "axisAligned"),
            true,
          );
          check(
            "tool.access",
            "required reach is 2.6 cm",
            field(access, "reach"),
            2.6,
            1e-9,
          );
          check(
            "tool.access",
            "declared tool length is sufficient",
            field(access, "lengthSufficient"),
            true,
          );
          validated("tool.access");
          const seating = await cad("fixture.access", {
            schemaVersion: 1,
            part: {
              name: "plate",
              features: [
                {
                  name: "pin",
                  kind: "pin",
                  origin: ["0 mm", "0 mm", "0 mm"],
                  direction: [0, 0, 1],
                  diameter: "2 mm",
                },
              ],
            },
            fixture: {
              name: "jig",
              approach: { direction: [0, 0, 1] },
              features: [
                {
                  name: "hole",
                  kind: "hole",
                  origin: ["0 mm", "0 mm", "0 mm"],
                  direction: [0, 0, 1],
                  diameter: "2.1 mm",
                },
              ],
            },
            pairs: [["pin", "hole"]],
            clearance: "0.05 mm",
            tolerance: "0.01 mm",
            angleTolerance: "1 deg",
          });
          check(
            "fixture.access",
            "pin fits the declared hole with required clearance",
            field(seating, "seatPossible"),
            true,
          );
          check(
            "fixture.access",
            "paired pin and hole have zero lateral offset",
            field(seating, "pairs", 0, "lateralOffset"),
            0,
            1e-9,
          );
          check(
            "fixture.access",
            "mating axes agree",
            field(seating, "pairs", 0, "angle"),
            0,
            1e-9,
          );
          check(
            "fixture.access",
            "no seating blockers are reported",
            field(seating, "blockers", "length"),
            0,
          );
          validated("fixture.access");
        },
        false,
      );
      if (failure !== undefined) throw failure;
      assert.equal(
        report.tests.length,
        declarationsOnly ? engineeringAnalyticDeclarationGroups.length + 1 : 26,
      );
      assert.ok(
        report.tests.every((row) => field(row, "status") === "pass"),
        JSON.stringify(report.tests),
      );
      await guard();
    },
  }));
}
