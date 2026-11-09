import type {
  ReviewRequest,
  ReviewRunPorts,
} from "../packages/core/src/application/review";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
import { createRequire } from "node:module";
import { at, list, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/review-application.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const Module = runtimeRequire("node:module");
import { createHash } from "node:crypto";
const { capturePng } = runtimeRequire("./capture-png") as {
  capturePng(
    width: number,
    height: number,
    seed?: number,
    blank?: boolean,
    compressionLevel?: number,
    variantDelta?: number,
  ): Buffer;
};
const { decodeReviewPng } = runtimeRequire(
  "../packages/node-adapters/dist/review/pixels",
) as typeof import("../packages/node-adapters/src/review/pixels");
const { CAPTURE_PIXEL_THRESHOLDS, evaluateReviewPixels } = runtimeRequire(
  "../packages/core/dist/application/review/pixels",
) as typeof import("../packages/core/src/application/review/pixels");
const baseline = runtimeRequire("./fixtures/review-report-contract.json") as {
  views: string[];
  schemaVersion: number;
  operation: string;
  status: string;
  requiresVisualReview: boolean;
  restoration: string;
  identityFields: string[];
};
const artifactsAdapter = runtimeRequire(
  "../src/dist/review",
) as typeof import("../packages/node-adapters/src/review");

const request = (out: string): ReviewRequest => ({
  doc: "Part α",
  docId: "creation-1",
  docFileId: null,
  out,
  fusionOut: out,
  width: 32,
  height: 32,
  requestId: "review-request-1",
});

function success(requestValue: ReviewRequest, { blankFirst = false } = {}) {
  const directions: Record<string, [number, number, number]> = {
    front: [0, -1, 0],
    back: [0, 1, 0],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 0, 1],
    bottom: [0, 0, -1],
    "iso-top-left": [-1, -1, 1],
    "iso-bottom-right": [1, -1, -1],
  };
  const captureRecipes = baseline.views.map((name) => ({
    name,
    kind: "orientation",
    orientation: name,
  }));
  const views = baseline.views.map((name, index) => {
    const bytes = capturePng(
      requestValue.width,
      requestValue.height,
      index + 1,
      blankFirst && index === 0,
    );
    const direction = present(directions[name]);
    return {
      name,
      file: name + ".png",
      status: "captured",
      recipeKind: "orientation",
      requestedOrientation: name,
      camera: {
        cameraType: "OrthographicCameraType",
        eye: direction.map((value) => value * 10),
        target: [0, 0, 0],
        up: [0, 0, 1],
        extents: [40, 30],
      },
      width: requestValue.width,
      height: requestValue.height,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const pixelIntegrity = evaluateReviewPixels(
    views.map((view, index) => {
      const direction = present(directions[view.name]);
      return {
        name: view.name,
        pixels: decodeReviewPng(
          capturePng(
            requestValue.width,
            requestValue.height,
            index + 1,
            blankFirst && index === 0,
          ),
          requestValue.width,
          requestValue.height,
          CAPTURE_PIXEL_THRESHOLDS,
        ),
        cameraDirection: direction,
      };
    }),
  );
  return {
    schemaVersion: baseline.schemaVersion,
    operation: baseline.operation,
    requestId: requestValue.requestId,
    success: true,
    status: baseline.status,
    requiresVisualReview: baseline.requiresVisualReview,
    documentIdentity: {
      name: requestValue.doc,
      creationId: requestValue.docId,
      fileId: null,
      version: 4,
      isSaved: true,
      isModified: false,
    },
    fusionBuild: "offline-fixture",
    views,
    captureRecipes,
    pixelIntegrity,
    errors: [] as { stage: string; message: string }[],
    restoration: { status: baseline.restoration } as {
      status: string;
      steps?: { name: string; status: string }[];
    },
    orientationVerification: { status: "verified" },
  };
}
function ports(
  out: string,
  report: ReturnType<typeof success>,
  { failPublication = false, blankFirst = false } = {},
) {
  const artifacts = artifactsAdapter.createReviewArtifactStore();
  const prepared: PreparedPythonArtifact = {
    context: null,
    request: null,
    bytes: [...Buffer.from("prepared review artifact")],
    version: 1,
    runtimeVersion: "cad-v1",
    sha256: "prepared-source-sha256",
    artifactHash: "prepared-artifact-hash",
    units: [
      {
        id: "legacy-review",
        source: "prepared review artifact",
        filename: "runtime/python/fmcad/adapters/fusion/legacy_review.py",
        role: "runtime",
        sha256: "review-source-sha256",
      },
    ],
    sourceMap: [
      {
        unitId: "legacy-review",
        generatedStartLine: 1,
        generatedEndLine: 10,
        sourceStartLine: 1,
      },
    ],
    script: "prepared review artifact",
  };
  if (failPublication) {
    const write = artifacts.writeExclusive;
    artifacts.writeExclusive = async (directory, name, content) => {
      if (name === "manifest.json") throw new Error("publication unavailable");
      return write(directory, name, content);
    };
  }
  let turns = 0;
  const ports: ReviewRunPorts = {
    artifacts,
    preparation: { prepare: () => prepared },
    sha256: artifactsAdapter.sha256ReviewImage,
    execution: {
      execute: async (input) => {
        turns++;
        assert.equal(input.operation, "review");
        assert.equal(input.context.docId, "creation-1");
        assert.equal(input.readOnly, false);
        assert.equal(input.artifact.script, "prepared review artifact");
        fs.writeFileSync(
          path.join(out, "backend-report.json"),
          JSON.stringify(report),
          { flag: "wx" },
        );
        if (report.success)
          for (const [index, view] of report.views.entries())
            fs.writeFileSync(
              path.join(out, view.file),
              capturePng(32, 32, index + 1, blankFirst && index === 0),
              {
                flag: "wx",
              },
            );
        return { report, failed: false };
      },
    },
  };
  return { ports, calls: () => turns };
}

test("application preserves the current report fixture and separates transport, images, and CAD status", async (t) => {
  const appPath = runtimeRequire.resolve("../src/dist/core/application/review");
  const originalLoad = Module._load;
  t.mock.method(
    Module,
    "_load",
    function (this: unknown, requested: string, ...args: unknown[]) {
      if (
        /^node:/.test(requested) ||
        ["fs", "path", "crypto", "terminal-kit"].includes(requested) ||
        /(?:^|\/)cli(?:\.js)?$/.test(requested)
      )
        assert.fail(
          "review application must not depend on host effects, terminal-kit, or the CLI",
        );
      return originalLoad.call(this, requested, ...args);
    },
  );
  delete runtimeRequire.cache[appPath];
  const application = runtimeRequire(
    "../src/dist/core/application/review",
  ) as typeof import("../packages/core/src/application/review");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-review-app-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = request(path.join(dir, "new"));
  const report = success(input);
  const fake = ports(input.out, report);

  const result = await application.executeReview(input, fake.ports);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(input.out, "manifest.json"), "utf8"),
  );
  assert.equal(result.code, 0);
  assert.equal(result.transport, "completed");
  assert.equal(result.artifacts, "complete");
  assert.equal(result.cadAcceptance, "not-evaluated");
  assert.equal(fake.calls(), 1);
  assert.equal(manifest.schemaVersion, baseline.schemaVersion);
  assert.equal(manifest.status, baseline.status);
  assert.equal(manifest.requiresVisualReview, true);
  assert.equal(manifest.sourceArtifact.sha256, "prepared-source-sha256");
  assert.equal(manifest.sourceArtifact.units[0].id, "legacy-review");
  assert.equal(manifest.restoration.status, baseline.restoration);
  assert.deepEqual(
    Object.keys(manifest.documentIdentity).sort(),
    baseline.identityFields,
  );
  assert.deepEqual(
    list(at(manifest, "views")).map((view) => at(view, "name")),
    baseline.views,
  );
});

test("capture and restoration failures retain partial report without implying success", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-review-partial-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = request(path.join(dir, "new"));
  const report = success(input);
  report.success = false;
  report.status = "failed";
  report.restoration = {
    status: "failed",
    steps: [{ name: "target.camera", status: "failed" }],
  };
  report.views = report.views.slice(0, 2);
  present(report.views[1]).status = "attempted";
  report.errors = [{ stage: "capture.left", message: "capture failed" }];
  const fake = ports(input.out, report);

  const result = await (
    runtimeRequire(
      "../src/dist/core/application/review",
    ) as typeof import("../packages/core/src/application/review")
  ).executeReview(input, fake.ports);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(input.out, "manifest.json"), "utf8"),
  );
  assert.equal(result.code, 1);
  assert.equal(result.transport, "completed");
  assert.equal(result.artifacts, "partial");
  assert.equal(result.cadAcceptance, "not-evaluated");
  assert.equal(manifest.success, false);
  assert.equal(manifest.restoration.status, "failed");
  assert.equal(manifest.views.length, 2);
  assert.deepEqual(manifest.errors, report.errors);
});

test("valid PNG headers and matching hashes do not admit a blank captured frame", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-review-blank-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = request(path.join(dir, "new"));
  const fake = ports(input.out, success(input, { blankFirst: true }), {
    blankFirst: true,
  });

  const result = await (
    runtimeRequire(
      "../src/dist/core/application/review",
    ) as typeof import("../packages/core/src/application/review")
  ).executeReview(input, fake.ports);
  assert.equal(result.code, 1);
  assert.equal(result.transport, "completed");
  assert.equal(result.artifacts, "invalid");
  assert.equal(result.report["success"], false);
  assert.equal(
    at(result.report, "pixelIntegrity", "views", 0, "status"),
    "blank",
  );
  assert.equal(
    at(list(result.report["errors"]).at(-1), "message"),
    "Review pixel integrity policy failed",
  );
});

test("missing pixel decoder leaves artifact quality unknown instead of passing", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-review-no-pixel-decoder-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = request(path.join(dir, "new"));
  const fake = ports(input.out, success(input));
  delete fake.ports.artifacts.decodePixels;

  const result = await (
    runtimeRequire(
      "../src/dist/core/application/review",
    ) as typeof import("../packages/core/src/application/review")
  ).executeReview(input, fake.ports);
  assert.equal(result.code, 1);
  assert.equal(result.transport, "completed");
  assert.equal(result.artifacts, "unknown");
  assert.equal(result.report["status"], "unknown");
  assert.match(
    text(at(list(result.report["errors"]).at(-1), "message")),
    /pixel decoder is unavailable/,
  );
});

test("manifest publication failure overrides an otherwise valid capture", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-review-publish-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = request(path.join(dir, "new"));
  const fake = ports(input.out, success(input), { failPublication: true });

  const result = await (
    runtimeRequire(
      "../src/dist/core/application/review",
    ) as typeof import("../packages/core/src/application/review")
  ).executeReview(input, fake.ports);
  assert.equal(result.code, 1);
  assert.equal(result.transport, "completed");
  assert.equal(result.artifacts, "complete");
  assert.equal(result.manifestWritten, false);
  assert.equal(result.report["success"], false);
  assert.equal(result.report["status"], "failed");
  assert.equal(
    at(list(result.report["errors"]).at(-1), "stage"),
    "publication",
  );
  assert.equal(fs.existsSync(path.join(input.out, "manifest.json")), false);
});
