import type { ReviewPlan, ReviewRequest } from "./contracts.js";
import { planReview } from "./plan.js";
import {
  CAPTURE_PIXEL_THRESHOLDS,
  evaluateReviewPixels,
  type DecodedReviewPixels,
  type ReviewPixelDiagnostics,
} from "./pixels.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function successfulReport(value: unknown): value is Row {
  return record(value) && value["success"] === true;
}

/** Validate the existing backend report contract without reading files or transport output. */
export function verifyReviewReport(
  value: unknown,
  request: ReviewRequest,
  plan: ReviewPlan = planReview(request),
): asserts value is Row {
  if (
    !record(value) ||
    value["operation"] !== "review" ||
    value["schemaVersion"] !== 1 ||
    value["requestId"] !== request.requestId ||
    value["requiresVisualReview"] !== true ||
    !Array.isArray(value["views"]) ||
    !Array.isArray(value["errors"])
  )
    throw new Error("Invalid review report identity/contract");
  if (!successfulReport(value)) return;
  const identity = value["documentIdentity"];
  const restoration = value["restoration"];
  const orientation = value["orientationVerification"];
  if (
    value["status"] !== "captured" ||
    !record(restoration) ||
    restoration["status"] !== "restored" ||
    (value["errors"] as unknown[]).length !== 0 ||
    !record(identity) ||
    identity["name"] !== request.doc ||
    (request.docId !== null && identity["creationId"] !== request.docId) ||
    (request.docFileId !== null && identity["fileId"] !== request.docFileId) ||
    typeof identity["isSaved"] !== "boolean" ||
    typeof identity["isModified"] !== "boolean" ||
    !value["fusionBuild"] ||
    (value["views"] as unknown[]).length !== plan.recipes.length ||
    !sameJson(value["captureRecipes"], plan.recipes) ||
    !record(orientation) ||
    !["verified", "readback-only"].includes(String(orientation["status"]))
  )
    throw new Error("Incomplete successful review report");
  for (const [index, row] of (value["views"] as unknown[]).entries()) {
    const recipe = plan.recipes[index]!;
    if (
      !record(row) ||
      row["name"] !== recipe.name ||
      row["file"] !== recipe.name + ".png" ||
      row["status"] !== "captured" ||
      row["recipeKind"] !== recipe.kind ||
      row["requestedOrientation"] !== recipe.orientation ||
      !record(row["camera"]) ||
      !validVector(row["camera"]["eye"]) ||
      !validVector(row["camera"]["target"]) ||
      !validVector(row["camera"]["up"])
    )
      throw new Error("Incomplete review view set");
    if (
      recipe.kind === "section" &&
      (!record(row["sectionReadback"]) ||
        row["sectionReadback"]["status"] !== "verified")
    )
      throw new Error("Section recipe was not verified by readback");
    if (recipe.kind === "roi" || recipe.kind === "detail") {
      const framing = row["framingReadback"];
      if (
        !record(framing) ||
        framing["kind"] !== recipe.kind ||
        !nearVector(framing["target"], recipe.target) ||
        !nearVector(framing["direction"], directionOf(row["camera"] as Row)) ||
        !validExtents(framing["extents"]) ||
        (recipe.kind === "roi" &&
          !nearVector(framing["extents"], recipe.extents)) ||
        (recipe.kind === "detail" &&
          (framing["scale"] !== recipe.scale ||
            !validExtents(framing["fittedExtents"]) ||
            !nearVector(
              framing["extents"],
              (framing["fittedExtents"] as readonly number[]).map(
                (extent) => extent * recipe.scale,
              ),
            )))
      )
        throw new Error("Review framing was not verified by camera readback");
    }
  }
}

/** Verify the exact bytes read from the artifact store, not a second file read. */
export async function verifyReviewImages(
  value: unknown,
  request: ReviewRequest,
  plan: ReviewPlan,
  artifacts: {
    readImage(
      directory: string,
      name: string,
    ): Promise<{ readonly regular: boolean; readonly bytes: Uint8Array }>;
  },
  sha256: (bytes: Uint8Array) => string,
  decodePixels: (
    bytes: Uint8Array,
    width: number,
    height: number,
    thresholds: typeof CAPTURE_PIXEL_THRESHOLDS,
  ) => DecodedReviewPixels,
): Promise<ReviewPixelDiagnostics | null> {
  verifyReviewReport(value, request, plan);
  if (!successfulReport(value)) return null;
  const rows = value["views"] as readonly Row[];
  const frames: {
    name: string;
    pixels: DecodedReviewPixels;
    cameraDirection: readonly [number, number, number];
  }[] = [];
  for (const [index, row] of rows.entries()) {
    const name = `${plan.recipes[index]!.name}.png`;
    const image = await artifacts.readImage(request.out, name);
    if (!image.regular)
      throw new Error("Review output is not a regular file: " + name);
    const bytes = image.bytes;
    if (
      bytes.length < 24 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d ||
      bytes[5] !== 0x0a ||
      bytes[6] !== 0x1a ||
      bytes[7] !== 0x0a ||
      String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR" ||
      readU32(bytes, 16) !== request.width ||
      readU32(bytes, 20) !== request.height ||
      bytes.length !== row["sizeBytes"] ||
      sha256(bytes) !== row["sha256"]
    )
      throw new Error("Review PNG readback mismatch: " + name);
    frames.push({
      name: plan.recipes[index]!.name,
      pixels: decodePixels(
        bytes,
        request.width,
        request.height,
        CAPTURE_PIXEL_THRESHOLDS,
      ),
      cameraDirection: directionOf(row["camera"] as Row),
    });
  }
  return evaluateReviewPixels(frames);
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validVector(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((coordinate) => Number.isFinite(coordinate))
  );
}

function directionOf(camera: Row): readonly [number, number, number] {
  const eye = camera["eye"] as readonly number[];
  const target = camera["target"] as readonly number[];
  const vector = [
    eye[0]! - target[0]!,
    eye[1]! - target[1]!,
    eye[2]! - target[2]!,
  ];
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= 1e-9)
    throw new Error("Review camera readback has an invalid direction");
  return [vector[0]! / length, vector[1]! / length, vector[2]! / length];
}

function nearVector(actual: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    actual.every((value, index) => Math.abs(value - expected[index]!) <= 1e-7)
  );
}

function validExtents(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((extent) => Number.isFinite(extent) && extent > 0)
  );
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}
