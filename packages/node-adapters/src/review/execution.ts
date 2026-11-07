import type {
  ReviewExecutionPort,
  ReviewExecutionReply,
} from "../../../core/src/application/review/contracts.js";

interface ReviewBackendReply {
  readonly text?: string;
  readonly failed?: boolean;
  readonly uiGuard?: unknown;
}
export interface ReviewBackendGateway {
  callTool(request: unknown, tool: string): Promise<ReviewBackendReply>;
}
export type ReviewOutputFormatter = (text: string, format: "json") => string;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Format/transport adapter; the application consumes a structured report. */
export function createReviewExecutionPort(
  gateway: ReviewBackendGateway,
  formatRunOutput: ReviewOutputFormatter,
): ReviewExecutionPort {
  return {
    async execute(request): Promise<ReviewExecutionReply> {
      const response = await gateway.callTool(
        {
          featureType: "script",
          object: { script: request.artifact.script },
        },
        "fusion_mcp_execute",
      );
      const guard = record(response.uiGuard) ? response.uiGuard : undefined;
      if (guard?.["notStarted"] === true)
        return {
          notStarted: true,
          failed: response.failed === true,
          ...(guard === undefined ? {} : { uiGuard: guard }),
        };
      return {
        report: JSON.parse(
          formatRunOutput(response.text ?? "", "json"),
        ) as unknown,
        failed: response.failed === true,
      };
    },
  };
}
