import type { PreparedPythonArtifact } from "../../domain/python-artifact";
import type { CadExecutionPort, CadExecutionReply } from "./contracts";

export interface RunIdentity {
  docId?: string;
  docFileId?: string;
  readOnly?: boolean;
}
export interface RunRequest {
  name: string;
  args: unknown;
  hasArgs: boolean;
  doc?: string;
  identity: RunIdentity;
  helperVersion?: string;
  readOnlyOperations: readonly string[];
}
export interface RunSource {
  filename: string;
  source: string;
}
export interface RunUnit extends RunSource {
  id: string;
  role: "user" | "runtime" | "wrapper";
  embedded?: boolean;
}
export interface RunPreparationPort {
  pythonValue(value: unknown): string;
  runtime(helperVersion: string | undefined): readonly RunUnit[];
  prepare(
    units: readonly RunUnit[],
    metadata: {
      request: Record<string, unknown>;
      context: Record<string, unknown>;
    },
  ): PreparedPythonArtifact;
}
/** Library/MCP entry after source-byte admission; no CLI parsing or publication. */
export function executeRun(
  request: RunRequest,
  source: RunSource,
  preparation: RunPreparationPort,
  execution: CadExecutionPort,
): Promise<CadExecutionReply> {
  const artifact = prepareRun(request, source, preparation);
  return execution.execute({
    operation: "run",
    artifact,
    readOnly: request.identity.readOnly === true,
    context: {
      ...(request.doc === undefined ? {} : { doc: request.doc }),
      ...request.identity,
    },
  });
}
export function validateRunRequest(request: RunRequest): void {
  const { helperVersion, doc, identity } = request;
  if (helperVersion !== undefined && helperVersion !== "cad-v1")
    throw new Error(`unknown helper version: ${helperVersion}`);
  if (
    helperVersion &&
    (!doc || (identity.docId === undefined && identity.docFileId === undefined))
  )
    throw new Error(
      "--helpers cad-v1 requires --doc and --doc-id or --doc-file-id",
    );
  validateRunIdentity({
    "--doc": doc,
    "--doc-id": identity.docId,
    "--doc-file-id": identity.docFileId,
  });
}
export function validateRunIdentity(
  flags: Record<string, unknown>,
  listing = false,
): void {
  if (!["--doc-id", "--doc-file-id"].some((flag) => flags[flag] !== undefined))
    return;
  if (listing)
    throw new Error("run identity guards cannot be combined with --list");
  if (typeof flags["--doc"] !== "string" || !flags["--doc"].trim())
    throw new Error("run identity guards require --doc <name>");
  for (const flag of ["--doc-id", "--doc-file-id"]) {
    const value = flags[flag];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !value ||
        /\s/.test(value) ||
        value.startsWith("-"))
    )
      throw new Error(
        `${flag} requires a nonempty identity without whitespace`,
      );
  }
}
/** The adapter supplies a snapshot already checked against the accepted byte hash. */
export function prepareRun(
  request: RunRequest,
  source: RunSource,
  port: RunPreparationPort,
  trustedStageContext?: unknown,
): PreparedPythonArtifact {
  validateRunRequest(request);
  const {
    name,
    args,
    hasArgs,
    doc: docName,
    identity,
    helperVersion,
    readOnlyOperations,
  } = request;
  const file = source.filename;
  let code = source.source;
  const pythonValue = (value: unknown): string =>
    "pythonLiteral" in port && typeof port.pythonLiteral === "function"
      ? port.pythonLiteral(value)
      : port.pythonValue(value);
  const pythonLiteral = pythonValue;
  if (hasArgs) {
    if (!/^ARGS = .*$/m.test(code))
      throw new Error(
        `${file} has no "ARGS = ..." config line; cannot inject --args`,
      );
    code = code.replace(/^ARGS = .*$/m, () => "ARGS = " + pythonValue(args));
  }
  if (docName) {
    if (!/^DOC_NAME = .*$/m.test(code))
      throw new Error(
        `${file} has no "DOC_NAME = ..." config line; cannot inject --doc`,
      );
    code = code.replace(
      /^DOC_NAME = .*$/m,
      () => "DOC_NAME = " + pythonValue(docName),
    );
  }
  const metadata = {
    request: { name, args, hasArgs, helperVersion, readOnlyOperations },
    context: {
      doc: docName,
      ...identity,
      ...(helperVersion
        ? {
            unitContexts: {
              "user-script": {
                kind: "cad-v1",
                deferredFacade: true,
                entrypoint: "run-if-present",
              },
            },
          }
        : {}),
    },
  };
  const runValueType = helperVersion ? "JsonValue | None" : "object | None";
  const userUnit: RunUnit = {
    id: "user-script",
    filename: file,
    source: code,
    role: "user",
  };
  if (
    identity.docId === undefined &&
    identity.docFileId === undefined &&
    !helperVersion
  )
    return port.prepare([userUnit], metadata);
  const units = port.runtime(helperVersion);
  const wrapper = `
def run(_context: str) -> ${runValueType}:
    from typing import Callable as _FMCAD_CALLABLE, cast as _FMCAD_CAST
    import adsk.core
    app = adsk.core.Application.get()
    doc = _document_target(app, ${pythonValue(docName)})
    doc_id, doc_file_id = ${pythonValue(identity.docId ?? null)}, ${pythonValue(identity.docFileId ?? null)}
    _document_assert_identity(doc, doc_id, doc_file_id)
    if ${identity.readOnly ? "False" : "True"}:
        _document_activate_target(app, doc, doc_id, doc_file_id)
    # Trusted-code precondition, not a sandbox. Do not inherit this wrapper's run.
    namespace: dict[str, object] = {'__name__': '__fmcad_script__', '__file__': ${pythonValue(file)},
                 '__fmcad_native_lifecycle__': globals().get('__fmcad_native_lifecycle__')}
    exec(compile(${pythonLiteral(code)}, ${pythonLiteral(file)}, 'exec', dont_inherit=True), namespace)
    if 'run' in namespace:
        if ${helperVersion ? "True" : "False"}:
            ctx = CadContext(${pythonValue(docName)}, None, None, doc_id, doc_file_id)
            facade = FMCAD(ctx, ${identity.readOnly ? "True" : "False"}, ${pythonLiteral(trustedStageContext ?? null)}, ${pythonLiteral(readOnlyOperations)})
            try:
                namespace['FMCAD'] = facade
                _user_run = _FMCAD_CAST(_FMCAD_CALLABLE[[str], ${runValueType}], namespace['run'])
                value: ${runValueType} = _user_run(_context)
                if value is not None and not facade.has_emitted: facade.emit(value)
                facade.terminal()
                return value
            except BaseException as exc:
                facade.terminal(exc)
                raise
        _user_run = _FMCAD_CAST(_FMCAD_CALLABLE[[str], ${runValueType}], namespace['run'])
        return _user_run(_context)
`;
  return port.prepare(
    [
      ...units,
      { ...userUnit, embedded: true },
      {
        id: "wrapper",
        filename: "<fmcad-run-wrapper>",
        source: wrapper,
        role: "wrapper",
      },
    ],
    metadata,
  );
}

export function validateRunOutput(
  flags: Record<string, unknown>,
  listing: boolean,
): void {
  const format = flags["--out-format"],
    pretty = flags["--pretty"];
  if (
    listing &&
    ["--out", "--out-format", "--pretty"].some(
      (flag) => flags[flag] !== undefined,
    )
  )
    throw new Error("run --list cannot be combined with output file options");
  if (
    (format !== undefined || pretty !== undefined) &&
    flags["--out"] === undefined
  )
    throw new Error("--out-format and --pretty require --out");
  if (format !== undefined && format !== "text" && format !== "json")
    throw new Error("--out-format must be text or json");
  if (pretty !== undefined && format !== "json")
    throw new Error("--pretty requires --out-format json");
  if (pretty !== undefined && pretty !== "true" && pretty !== "false")
    throw new Error("--pretty must be true or false");
}
export function formatRunOutput(
  text: string,
  format = "text",
  pretty = false,
): string {
  if (format === "text") return text;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    const markers = text
      .split(/\r?\n/)
      .filter((line) => /^FMCAD_RESULT(?:\s|$)/.test(line));
    if (markers.length !== 1)
      throw new Error(
        "JSON output requires a whole JSON value or exactly one FMCAD_RESULT marker",
      );
    try {
      value = JSON.parse(markers[0]!.replace(/^FMCAD_RESULT/, "")) as unknown;
    } catch {
      throw new Error("Malformed JSON output result marker");
    }
  }
  return JSON.stringify(value, null, pretty ? 2 : 0) + "\n";
}
