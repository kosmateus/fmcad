import path from "node:path";
import { createRequire } from "node:module";

interface DiagnosticResult {
  code: number;
  calls: unknown[];
  stdout: string;
  stderr: string;
  loads: number;
}
type DiagnosticCommand = (
  argv: string[],
  backend?: "mcp" | "addin",
  text?: string,
) => Promise<DiagnosticResult>;

/** The existing real CLI/worker diagnostic fixture; only its wire endpoint is replaced. */
export const executeDiagnostic = createRequire(
  path.join(__dirname, "../../package.json"),
)("./tests/helpers/diagnostic-command") as DiagnosticCommand;
