export const CAPTURE_PIXEL_THRESHOLDS = Object.freeze({
  maxPixels: 16_000_000,
  thumbnailSize: 32,
  edgeDelta: 12,
  colorBinBits: 4,
  minEdgePixelRatio: 0.00002,
  minLumaStandardDeviation: 1.5,
  minDistinctColorBins: 3,
  duplicateMeanAbsoluteChannelDelta: 0.5,
  duplicateSampleDelta: 4,
  duplicateSampleRatio: 0.995,
  similarMeanAbsoluteChannelDelta: 3,
  similarSampleDelta: 8,
  similarSampleRatio: 0.98,
});
export type CapturePixelThresholds = typeof CAPTURE_PIXEL_THRESHOLDS;

export interface DecodedReviewPixels {
  readonly width: number;
  readonly height: number;
  /** SHA-256 of decoded RGBA pixels, independent of PNG metadata/compression. */
  readonly pixelDigest: string;
  readonly edgePixelRatio: number;
  readonly lumaStandardDeviation: number;
  readonly distinctColorBins: number;
  /** A deterministic 32x32 RGB thumbnail used only for non-failing similarity diagnostics. */
  readonly thumbnail: Uint8Array;
}

export interface ReviewPixelDiagnostics {
  readonly policy: "capture-pixels-v1";
  readonly status: "verified" | "review-required" | "failed";
  readonly thresholds: typeof CAPTURE_PIXEL_THRESHOLDS;
  readonly views: readonly {
    readonly name: string;
    readonly status: "nonblank" | "blank";
    readonly edgePixelRatio: number;
    readonly lumaStandardDeviation: number;
    readonly distinctColorBins: number;
  }[];
  readonly duplicatePairs: readonly {
    readonly left: string;
    readonly right: string;
    readonly kind: "exact-decoded-pixels" | "near-identical-pixels";
  }[];
  readonly similarPairs: readonly {
    readonly left: string;
    readonly right: string;
    readonly meanAbsoluteChannelDelta: number;
    readonly reason: "similar-pixels" | "exact-pixels-distinct-directions";
  }[];
}

/** Apply the host-independent blank/duplicate policy to decoded pixel evidence. */
export function evaluateReviewPixels(
  frames: readonly {
    readonly name: string;
    readonly pixels: DecodedReviewPixels;
    readonly cameraDirection: readonly [number, number, number];
  }[],
): ReviewPixelDiagnostics {
  const views = frames.map(({ name, pixels }) => {
    const blank =
      pixels.edgePixelRatio < CAPTURE_PIXEL_THRESHOLDS.minEdgePixelRatio ||
      pixels.lumaStandardDeviation <
        CAPTURE_PIXEL_THRESHOLDS.minLumaStandardDeviation ||
      pixels.distinctColorBins < CAPTURE_PIXEL_THRESHOLDS.minDistinctColorBins;
    return {
      name,
      status: blank ? ("blank" as const) : ("nonblank" as const),
      edgePixelRatio: pixels.edgePixelRatio,
      lumaStandardDeviation: pixels.lumaStandardDeviation,
      distinctColorBins: pixels.distinctColorBins,
    };
  });
  const duplicatePairs: {
    left: string;
    right: string;
    kind: "exact-decoded-pixels" | "near-identical-pixels";
  }[] = [];
  const similarPairs: {
    left: string;
    right: string;
    meanAbsoluteChannelDelta: number;
    reason: "similar-pixels" | "exact-pixels-distinct-directions";
  }[] = [];

  for (let left = 0; left < frames.length; left++) {
    for (let right = left + 1; right < frames.length; right++) {
      const a = frames[left]!;
      const b = frames[right]!;
      if (
        a.pixels.width !== b.pixels.width ||
        a.pixels.height !== b.pixels.height
      )
        continue;
      if (a.pixels.pixelDigest === b.pixels.pixelDigest) {
        if (sameDirection(a.cameraDirection, b.cameraDirection))
          duplicatePairs.push({
            left: a.name,
            right: b.name,
            kind: "exact-decoded-pixels",
          });
        else
          similarPairs.push({
            left: a.name,
            right: b.name,
            meanAbsoluteChannelDelta: 0,
            reason: "exact-pixels-distinct-directions",
          });
        continue;
      }
      const similarity = compareThumbnails(
        a.pixels.thumbnail,
        b.pixels.thumbnail,
      );
      if (
        sameDirection(a.cameraDirection, b.cameraDirection) &&
        similarity.meanAbsoluteChannelDelta <=
          CAPTURE_PIXEL_THRESHOLDS.duplicateMeanAbsoluteChannelDelta &&
        similarity.duplicateCloseSampleRatio >=
          CAPTURE_PIXEL_THRESHOLDS.duplicateSampleRatio
      ) {
        duplicatePairs.push({
          left: a.name,
          right: b.name,
          kind: "near-identical-pixels",
        });
      } else if (
        similarity.meanAbsoluteChannelDelta <=
          CAPTURE_PIXEL_THRESHOLDS.similarMeanAbsoluteChannelDelta &&
        similarity.closeSampleRatio >=
          CAPTURE_PIXEL_THRESHOLDS.similarSampleRatio
      ) {
        similarPairs.push({
          left: a.name,
          right: b.name,
          meanAbsoluteChannelDelta: similarity.meanAbsoluteChannelDelta,
          reason: "similar-pixels",
        });
      }
    }
  }

  const failed =
    views.some((view) => view.status === "blank") || duplicatePairs.length > 0;
  return {
    policy: "capture-pixels-v1",
    status: failed
      ? "failed"
      : similarPairs.length > 0
        ? "review-required"
        : "verified",
    thresholds: CAPTURE_PIXEL_THRESHOLDS,
    views,
    duplicatePairs,
    // Similar but distinct views are diagnostic only: symmetric/low-detail
    // geometry may legitimately produce very similar projections.
    similarPairs,
  };
}

function sameDirection(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): boolean {
  const dot = left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  return dot >= 0.9999;
}

function compareThumbnails(
  left: Uint8Array,
  right: Uint8Array,
): {
  meanAbsoluteChannelDelta: number;
  closeSampleRatio: number;
  duplicateCloseSampleRatio: number;
} {
  if (left.length !== right.length || left.length === 0)
    return {
      meanAbsoluteChannelDelta: Number.POSITIVE_INFINITY,
      closeSampleRatio: 0,
      duplicateCloseSampleRatio: 0,
    };
  let delta = 0;
  let close = 0;
  let duplicateClose = 0;
  for (let index = 0; index < left.length; index++) {
    const difference = Math.abs(left[index]! - right[index]!);
    delta += difference;
    if (difference <= CAPTURE_PIXEL_THRESHOLDS.similarSampleDelta) close++;
    if (difference <= CAPTURE_PIXEL_THRESHOLDS.duplicateSampleDelta)
      duplicateClose++;
  }
  return {
    meanAbsoluteChannelDelta: delta / left.length,
    closeSampleRatio: close / left.length,
    duplicateCloseSampleRatio: duplicateClose / left.length,
  };
}
