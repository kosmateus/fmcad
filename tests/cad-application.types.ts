import type {
  CadContext,
  CadExecutionPort,
  CadExecutionRequest,
  RunRequest,
  AtomicServices,
  CadWorkerInvocation,
  ParsedCadWorkerCommand,
} from "../packages/core/src/application/cad";
const context: CadContext = { doc: "Model", docId: "creation-1" };
// @ts-expect-error context is targeting, not a transport/client container
context.client = { callTool() {} };
const turn: CadExecutionRequest = {
  operation: "document.status",
  context,
  readOnly: true,
  // @ts-expect-error admission must carry the complete prepared immutable artifact
  artifact: { script: "print('not admitted')" },
};
const execution: CadExecutionPort = {
  // @ts-expect-error no raw argv/script-string execution port
  execute: async (argv: readonly string[]) => {
    void argv;
    return { text: "" };
  },
};
const request: RunRequest = {
  name: "trusted.py",
  args: null,
  hasArgs: false,
  // @ts-expect-error identity guards are explicit strings, never CLI words
  identity: { docId: ["--doc-id", "id"] },
  readOnlyOperations: [],
};
declare const services: AtomicServices;
// @ts-expect-error no direct unprepared RPC/CLI executor on atomic application service
services.call({ operation: "atomic_start" }, false);
void [turn, execution, request];
// @ts-expect-error workers consume a versioned invocation, never executable argv
const workerInput: CadWorkerInvocation = { argv: ["run", "script.py"] };
const parsed: ParsedCadWorkerCommand = {
  kind: "run",
  request: { name: "trusted.py", args: [], hasArgs: false, identity: {} },
  // @ts-expect-error output formatting uses explicit DTO fields, not CLI options
  output: { "--out": "result.json" },
};
void [workerInput, parsed];
