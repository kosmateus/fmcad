import type { PreparedPythonArtifact } from "../../domain/python-artifact.js";

export type ReviewOrientation =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "iso-top-left"
  | "iso-bottom-right"
  | "iso-top-right"
  | "iso-bottom-left";

interface ReviewRecipeBase {
  readonly name: string;
  readonly orientation: ReviewOrientation;
}

export type ReviewCaptureRecipe =
  | (ReviewRecipeBase & { readonly kind: "orientation" })
  | (ReviewRecipeBase & {
      readonly kind: "roi";
      /** Model-space target in Fusion centimetres. */
      readonly target: readonly [number, number, number];
      /** Orthographic width and height in Fusion centimetres. */
      readonly extents: readonly [number, number];
    })
  | (ReviewRecipeBase & {
      readonly kind: "detail";
      /** Model-space target in Fusion centimetres. */
      readonly target: readonly [number, number, number];
      /** Fraction of the fitted orthographic frame, from 0.05 through 0.75. */
      readonly scale: number;
    })
  | (ReviewRecipeBase & {
      readonly kind: "section";
      readonly sectionName: string;
      readonly visible: boolean;
    });

export interface ReviewRequest {
  readonly doc: string;
  readonly docId: string | null;
  readonly docFileId: string | null;
  readonly out: string;
  readonly fusionOut: string;
  readonly width: number;
  readonly height: number;
  readonly requestId: string;
  /** Omitted means the compatible eight-view recipe; supplied recipes replace it. */
  readonly recipes?: readonly ReviewCaptureRecipe[];
}

export interface ReviewPlan {
  readonly operation: "review";
  readonly views: readonly string[];
  readonly recipes: readonly ReviewCaptureRecipe[];
  readonly request: ReviewRequest;
}

export interface ReviewExecutionRequest {
  readonly operation: "review";
  readonly context: {
    readonly doc: string;
    readonly docId: string | null;
    readonly docFileId: string | null;
  };
  readonly artifact: PreparedPythonArtifact;
  /** Review changes viewport state and must not be advertised as read-only. */
  readonly readOnly: false;
}

export interface ReviewExecutionReply {
  readonly report?: unknown;
  readonly failed?: boolean;
  readonly notStarted?: boolean;
  readonly uiGuard?: unknown;
}

/** Adapter for the existing broker gateway; no transport or SDK belongs here. */
export interface ReviewExecutionPort {
  execute(request: ReviewExecutionRequest): Promise<ReviewExecutionReply>;
}

/** All output-directory effects stay in the host artifact adapter. */
export interface ReviewArtifactStore {
  claim(directory: string): Promise<void>;
  writeExclusive(
    directory: string,
    name: string,
    content: string | Uint8Array,
  ): Promise<void>;
  readText(directory: string, name: string): Promise<string>;
  readImage(
    directory: string,
    name: string,
  ): Promise<{ readonly regular: boolean; readonly bytes: Uint8Array }>;
  /** Optional host convenience; required at runtime for successful pixel verification. */
  decodePixels?(
    bytes: Uint8Array,
    width: number,
    height: number,
    thresholds: import("./pixels.js").CapturePixelThresholds,
  ): import("./pixels.js").DecodedReviewPixels;
}

export interface ReviewPreparationPort {
  prepare(request: ReviewRequest): PreparedPythonArtifact;
}

export interface ReviewRunPorts {
  readonly artifacts: ReviewArtifactStore;
  readonly execution: ReviewExecutionPort;
  readonly preparation: ReviewPreparationPort;
  readonly sha256: (bytes: Uint8Array) => string;
  /** No decoder means pixel quality is unknown and a backend capture cannot pass. */
  readonly decodePixels?: (
    bytes: Uint8Array,
    width: number,
    height: number,
    thresholds: import("./pixels.js").CapturePixelThresholds,
  ) => import("./pixels.js").DecodedReviewPixels;
}

export type ReviewTransportStatus =
  "not-submitted" | "rejected" | "unknown" | "completed" | "failed";
export type ReviewArtifactStatus =
  | "not-checked"
  | "unknown"
  | "incomplete"
  | "partial"
  | "complete"
  | "review-required"
  | "invalid";

export interface ReviewRunResult {
  readonly report: Record<string, unknown>;
  readonly code: 0 | 1;
  readonly transport: ReviewTransportStatus;
  readonly artifacts: ReviewArtifactStatus;
  /** Visual evidence never evaluates CAD or physical acceptance. */
  readonly cadAcceptance: "not-evaluated";
  readonly manifestWritten: boolean;
}
