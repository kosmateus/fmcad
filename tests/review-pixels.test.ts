import { createRequire } from "node:module";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/review-pixels.test.js");
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const { planReview } = runtimeRequire(
  "../packages/core/dist/application/review/plan",
) as typeof import("../packages/core/src/application/review/plan");
const decode = (bytes: Buffer, width: number, height: number) =>
  decodeReviewPng(bytes, width, height, CAPTURE_PIXEL_THRESHOLDS);

test("PNG decoding validates actual pixels and is independent of PNG encoding hash", () => {
  const ordinary = capturePng(32, 32, 3, false, 6);
  const differentlyEncoded = capturePng(32, 32, 3, false, 1);
  assert.notEqual(
    createHash("sha256").update(ordinary).digest("hex"),
    createHash("sha256").update(differentlyEncoded).digest("hex"),
  );
  assert.equal(
    decode(ordinary, 32, 32).pixelDigest,
    decode(differentlyEncoded, 32, 32).pixelDigest,
  );
  assert.throws(
    () => decode(Buffer.concat([ordinary, Buffer.from("tampered")]), 32, 32),
    /PNG/,
  );
  assert.throws(() => decode(ordinary, 31, 32), /dimensions/);
});

test("blank images and same-direction exact duplicate pixels fail despite valid PNG/hash", () => {
  const blank = decode(capturePng(32, 32, 0, true), 32, 32);
  const part = decode(capturePng(32, 32, 1), 32, 32);
  const result = evaluateReviewPixels([
    { name: "blank", pixels: blank, cameraDirection: [0, -1, 0] },
    { name: "part", pixels: part, cameraDirection: [0, 1, 0] },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(present(result.views[0]).status, "blank");
  assert.ok(result.thresholds.minEdgePixelRatio > 0);

  const exact = evaluateReviewPixels([
    { name: "front", pixels: part, cameraDirection: [0, -1, 0] },
    { name: "repeated-front", pixels: part, cameraDirection: [0, -1, 0] },
  ]);
  assert.equal(exact.status, "failed");
  assert.deepEqual(exact.duplicatePairs, [
    {
      left: "front",
      right: "repeated-front",
      kind: "exact-decoded-pixels",
    },
  ]);

  const almostSame = decode(capturePng(32, 32, 1, false, 6, 1), 32, 32);
  const nearDuplicate = evaluateReviewPixels([
    { name: "front", pixels: part, cameraDirection: [0, -1, 0] },
    {
      name: "repeat-with-noise",
      pixels: almostSame,
      cameraDirection: [0, -1, 0],
    },
  ]);
  assert.equal(nearDuplicate.status, "failed");
  assert.equal(
    present(nearDuplicate.duplicatePairs[0]).kind,
    "near-identical-pixels",
  );
});

test("legitimately similar distinct frames are retained as diagnostics, not rejected", () => {
  const base = decode(capturePng(32, 32, 2), 32, 32);
  const near = decode(capturePng(32, 32, 2, false, 6, 1), 32, 32);
  const result = evaluateReviewPixels([
    { name: "front", pixels: base, cameraDirection: [0, -1, 0] },
    { name: "back", pixels: near, cameraDirection: [0, 1, 0] },
  ]);
  assert.equal(result.status, "review-required");
  assert.deepEqual(result.duplicatePairs, []);
  assert.equal(result.similarPairs.length, 1);
  assert.equal(present(result.similarPairs[0]).reason, "similar-pixels");
});

test("canonical Fusion and local readback emit identical pixel policy diagnostics", () => {
  const vectors: [number, number, number][] = [
    [0, -1, 0],
    [0, 1, 0],
    [-1, 0, 0],
  ];
  const inputs = [
    capturePng(32, 32, 1),
    capturePng(32, 32, 1, false, 1),
    capturePng(32, 32, 2, false, 6, 1),
  ].map((bytes, index) => ({
    name: "frame-" + index,
    bytes,
    direction: present(vectors[index]),
  }));
  const local = evaluateReviewPixels(
    inputs.map((frame) => {
      const length = Math.hypot(...frame.direction);
      return {
        name: frame.name,
        pixels: decode(frame.bytes, 32, 32),
        cameraDirection: frame.direction.map((value) => value / length) as [
          number,
          number,
          number,
        ],
      };
    }),
  );
  const source = path.resolve(
    testRoot + "/tests",
    "../runtime/python/fmcad/domain/capture_integrity.py",
  );
  const python = `import base64, json, pathlib, sys
namespace = {}
source = pathlib.Path(sys.argv[1]).read_text()
exec(compile(source, sys.argv[1], 'exec'), namespace)
frames = json.loads(sys.stdin.read())
for frame in frames:
    frame['bytes'] = base64.b64decode(frame['bytes'])
print(json.dumps(namespace['analyze_capture_pixels'](frames), allow_nan=False))
`;
  const result = spawnSync("python3", ["-B", "-c", python, source], {
    input: JSON.stringify(
      inputs.map((frame) => ({
        ...frame,
        bytes: frame.bytes.toString("base64"),
      })),
    ),
    encoding: "utf8",
    cwd: "/tmp/opencode",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), local);
});

test("selectable ROI/detail/section recipes are validated and keep safe output names", () => {
  const request: import("../packages/core/src/application/review").ReviewRequest =
    {
      doc: "Fixture",
      docId: "creation",
      docFileId: null,
      out: "/tmp/out",
      fusionOut: "C:\\mapped\\out",
      width: 32,
      height: 32,
      requestId: "recipes",
      recipes: [
        {
          name: "roi-top",
          kind: "roi",
          orientation: "top",
          target: [0, 0, 0],
          extents: [2, 3],
        },
        {
          name: "detail-front",
          kind: "detail",
          orientation: "front",
          target: [1, 2, 3],
          scale: 0.25,
        },
        {
          name: "section-side",
          kind: "section",
          orientation: "left",
          sectionName: "Mid cut",
          visible: true,
        },
      ],
    };
  const plan = planReview(request);
  assert.deepEqual(plan.views, ["roi-top", "detail-front", "section-side"]);
  assert.deepEqual(plan.recipes, request.recipes);
  assert.throws(
    () =>
      planReview({
        ...request,
        recipes: [
          {
            name: "../outside",
            kind: "roi",
            orientation: "top",
            target: [0, 0, 0],
            extents: [2, 3],
          },
        ],
      }),
    /safe filenames/,
  );
  assert.throws(
    () =>
      planReview({
        ...request,
        recipes: [
          {
            name: "detail-front",
            kind: "detail",
            orientation: "front",
            target: [0, 0, 0],
            scale: 0,
          },
        ],
      }),
    /scale/,
  );
});
