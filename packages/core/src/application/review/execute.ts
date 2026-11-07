import type {
  ReviewArtifactStatus,
  ReviewRequest,
  ReviewRunPorts,
  ReviewRunResult,
  ReviewTransportStatus,
} from "./contracts.js";
import type { PreparedPythonArtifact } from "../../domain/python-artifact.js";
import { planReview } from "./plan.js";
import { verifyReviewImages, verifyReviewReport } from "./verify.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function reportStatus(
  report: Record<string, unknown>,
  status: string,
  error: { stage: string; message: string },
): Record<string, unknown> {
  const errors = Array.isArray(report["errors"]) ? report["errors"] : [];
  return {
    ...report,
    success: false,
    status,
    errors: [...errors, error],
  };
}
function emptyReport(requestId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: "review",
    requestId,
    success: false,
    status: "not-submitted",
    requiresVisualReview: true,
    views: [],
    errors: [],
    restoration: { status: "not-needed" },
  };
}
function sourceEvidence(
  artifact: PreparedPythonArtifact,
): Record<string, unknown> {
  return {
    version: artifact.version,
    runtimeVersion: artifact.runtimeVersion,
    sha256: artifact.sha256,
    artifactHash: artifact.artifactHash,
    units: Array.isArray(artifact.units)
      ? artifact.units.map(({ id, filename, role, sha256 }) => ({
          id,
          filename,
          role,
          sha256,
        }))
      : [],
    sourceMap: Array.isArray(artifact.sourceMap) ? artifact.sourceMap : [],
  };
}
function encode(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
function failedStage(
  error: unknown,
  submitted: boolean,
): {
  readonly status: string;
  readonly transport: ReviewTransportStatus;
  readonly restoration: Record<string, unknown>;
  readonly extra: Record<string, unknown>;
} {
  const notStarted = isRecord(error) && error["notStarted"] === true;
  return {
    status: notStarted
      ? "rejected-before-capture"
      : submitted
        ? "unknown"
        : "not-submitted",
    transport: notStarted
      ? "rejected"
      : submitted
        ? "unknown"
        : "not-submitted",
    restoration: notStarted
      ? { status: "not-needed" }
      : submitted
        ? { status: "unknown" }
        : { status: "not-needed" },
    extra: {
      ...(notStarted ? { operationSubmitted: false } : {}),
      recovery: notStarted
        ? "Capture was rejected before its SDK turn. Inspect the queue precondition/context result before submitting a fresh command."
        : "Preserve all outputs. Inspect backend-report.json and Fusion state before any new invocation; do not replay.",
    },
  };
}

/** Broker-backed capture, durable artifact readback, and publication orchestration. */
export async function executeReview(
  request: ReviewRequest,
  ports: ReviewRunPorts,
): Promise<ReviewRunResult> {
  const plan = planReview(request);
  // Match the legacy preflight order: preparation errors do not claim a destination.
  const artifact = ports.preparation.prepare(request);
  await ports.artifacts.claim(request.out);

  const evidence = sourceEvidence(artifact);
  let report: Record<string, unknown> = {
    ...emptyReport(request.requestId),
    sourceArtifact: evidence,
  };
  let submitted = false;
  let backendReportVerified = false;
  let transport: ReviewTransportStatus = "not-submitted";
  let artifacts: ReviewArtifactStatus = "not-checked";
  try {
    await ports.artifacts.writeExclusive(
      request.out,
      "request.json",
      encode(request),
    );
    submitted = true;
    const reply = await ports.execution.execute({
      operation: "review",
      context: {
        doc: request.doc,
        docId: request.docId,
        docFileId: request.docFileId,
      },
      artifact,
      readOnly: false,
    });
    if (reply.notStarted === true) {
      transport = "rejected";
      report = {
        ...report,
        status: "rejected-before-capture",
        errors: [
          {
            stage: "preflight",
            message: "Backend active-command guard rejected script",
            ...(reply.uiGuard === undefined ? {} : { guard: reply.uiGuard }),
          },
        ],
      };
    } else {
      transport = reply.failed === true ? "failed" : "completed";
      artifacts = "unknown";
      const text = await ports.artifacts.readText(
        request.out,
        "backend-report.json",
      );
      const durable = JSON.parse(text) as unknown;
      if (JSON.stringify(reply.report) !== JSON.stringify(durable))
        throw new Error("Terminal and durable backend reports differ");
      artifacts = "invalid";
      verifyReviewReport(durable, request, plan);
      backendReportVerified = true;
      report = {
        ...(durable as Record<string, unknown>),
        sourceArtifact: evidence,
      };
      if (isRecord(durable) && durable["success"] === true) {
        artifacts = "invalid";
        const decodePixels = ports.decodePixels ?? ports.artifacts.decodePixels;
        if (!decodePixels) {
          report = reportStatus(report, "unknown", {
            stage: "pixelIntegrity",
            message:
              "Review pixel decoder is unavailable; image quality is unknown",
          });
          artifacts = "unknown";
        } else {
          try {
            const pixelIntegrity = await verifyReviewImages(
              durable,
              request,
              plan,
              ports.artifacts,
              ports.sha256,
              decodePixels,
            );
            if (!pixelIntegrity)
              throw new Error("Review pixel diagnostics are unavailable");
            report = { ...report, pixelIntegrity };
            if (
              JSON.stringify(durable["pixelIntegrity"]) !==
              JSON.stringify(pixelIntegrity)
            ) {
              report = reportStatus(report, "unknown", {
                stage: "pixelIntegrity",
                message: "Backend and local pixel diagnostics differ",
              });
              artifacts = "unknown";
            } else if (pixelIntegrity.status === "failed") {
              report = reportStatus(report, "failed", {
                stage: "pixelIntegrity",
                message: "Review pixel integrity policy failed",
              });
              artifacts = "invalid";
            } else {
              artifacts =
                pixelIntegrity.status === "review-required"
                  ? "review-required"
                  : "complete";
            }
          } catch (error) {
            report = reportStatus(report, "failed", {
              stage: "pixelIntegrity",
              message: message(error),
            });
            artifacts = "invalid";
          }
        }
      } else {
        artifacts =
          isRecord(durable) && Array.isArray(durable["views"])
            ? durable["views"].length > 0
              ? "partial"
              : "incomplete"
            : "invalid";
      }
      if (reply.failed === true) {
        report = reportStatus(report, "failed", {
          stage: "transport",
          message: "Backend marked execution failed; capture is not accepted",
        });
      }
    }
  } catch (error) {
    const failed = failedStage(error, submitted);
    if (transport === "not-submitted") transport = failed.transport;
    report = {
      ...report,
      success: false,
      status: failed.status,
      ...(failed.status === "rejected-before-capture"
        ? { operationSubmitted: false }
        : {}),
      restoration: backendReportVerified
        ? (report["restoration"] as Record<string, unknown>)
        : failed.restoration,
      errors: [
        ...(Array.isArray(report["errors"]) ? report["errors"] : []),
        { stage: "command", message: message(error) },
      ],
      ...failed.extra,
    };
    if (artifacts === "not-checked")
      artifacts = submitted ? "unknown" : "not-checked";
  }

  let manifestWritten = false;
  try {
    await ports.artifacts.writeExclusive(
      request.out,
      "manifest.json",
      encode({
        ...report,
        localDirectory: request.out,
        fusionDirectory: request.fusionOut,
      }),
    );
    manifestWritten = true;
  } catch (error) {
    report = reportStatus(report, "failed", {
      stage: "publication",
      message: message(error),
    });
  }
  return {
    report,
    code:
      report["success"] === true &&
      report["status"] === "captured" &&
      manifestWritten
        ? 0
        : 1,
    transport,
    artifacts,
    cadAcceptance: "not-evaluated",
    manifestWritten,
  };
}
