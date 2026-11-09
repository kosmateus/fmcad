import type { OperationDeclaration } from "../../catalog";
import type { CadContext, CadData } from "./contracts";

export interface CadScriptPlan {
  wrapper: string;
  request: CadData;
  context: CadContext;
  profile: "document-status" | "full";
}
/** Pure wrapper plan. Source loading, path mapping and bundling are adapters. */
export function planCadScript(
  operation: string,
  data: CadData,
  context: CadContext,
  entry: OperationDeclaration,
  pythonLiteral: (value: unknown) => string,
): CadScriptPlan {
  const lightStatus =
    operation === "document.status" && context.component == null;
  const minimal = lightStatus
    ? '\n\ndef _document_status_minimal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":\n    _cad_fields(data)\n    return _document_snapshot(ctx.doc)\n\nCAD_HANDLERS["document.status"] = _document_status_minimal\n'
    : "";
  const request = {
    operation,
    data,
    doc: context.doc,
    component: context.component,
    projectId: context.projectId,
    docId: context.docId,
    docFileId: context.docFileId,
  };
  const requestType = `from typing import TYPE_CHECKING as _FMCAD_TYPE_CHECKING
if _FMCAD_TYPE_CHECKING:
    from typing import TypedDict as _FMCADTypedDict, NotRequired as _FMCADNotRequired

    class _FMCADRequest(_FMCADTypedDict):
        operation: str
        data: JsonObject
        doc: str
        component: _FMCADNotRequired[${context.component !== null && typeof context.component === "object" ? "str | JsonObject | None" : "str | None"}]
        projectId: _FMCADNotRequired[str | None]
        docId: _FMCADNotRequired[str | None]
        docFileId: _FMCADNotRequired[str | None]
`;
  const wrapper =
    minimal +
    `\n\n${requestType}
_FMCAD_REQUEST: "_FMCADRequest" = ${pythonLiteral(request)}

def run(_context: str):
    # Fail before touching Fusion if the host has leaked nested output wrappers.
    # Keep all host sanitization in place; never replace or unwrap the streams.
    from typing import cast as _FMCAD_CAST
    import sys
    for stream in (sys.stdout, sys.stderr):
        current: object = stream
        seen: set[int] = set()
        while type(current).__name__ == '_NsSanitizedWriter':
            if id(current) in seen or len(seen) >= 64:
                raise RuntimeError('FMCAD_MCP_STREAM_EXHAUSTED: the host has accumulated nested sanitized output writers. No CAD operation was started. Restart or repair the MCP add-in; output filtering has not been changed.')
            seen.add(id(current))
            attributes = _FMCAD_CAST("dict[str, object]", object.__getattribute__(current, '__dict__'))
            current = attributes['_original']
    request = _FMCAD_REQUEST
    ctx = CadContext(request['doc'], request.get('component'), request.get('projectId'), request.get('docId'), request.get('docFileId'))
    if ${entry.readOnly || operation === "document.clear" || operation === "document.save_native" || operation === "selection.highlight" || (operation.startsWith("camera.") && operation !== "camera.set") || operation === "shot.pack" ? "False" : "True"}:
        ctx.activate_target()
    ctx.assert_identity()
    print('FMCAD_PROGRESS ' + json.dumps({'operation': request['operation'], 'document': ctx.doc.name, 'state': 'started'}))
    result = ctx.call(request['operation'], request['data'])
    success = not (isinstance(result, dict) and (result.get('passed') is False or (result.get('restored') is False and result.get('leftRequestedState') is not True and result.get('status') != 'pass') or result.get('sampledPassed') is False or result.get('checkOutcome') == 'fail' or result.get('status') in ('fail', 'failed', 'blocked', 'unknown', 'missing', 'stale')))
    print('FMCAD_RESULT ' + json.dumps(_cad_json({'success': success, 'operation': request['operation'], 'document': ctx.doc.name, 'result': result, 'created': ctx.created}), allow_nan=False))
`;
  return {
    wrapper,
    request,
    context,
    profile: lightStatus ? "document-status" : "full",
  };
}
