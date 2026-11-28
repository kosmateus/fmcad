import type { OperationDeclaration } from "../../catalog";
import type { CadContext, CadData, CameraAliasObservation } from "./contracts";

/** Compiler-only selection, never decoded from a public CAD invocation. */
export type CadPrivateReadback = "param-checkpoint";

export interface CadScriptPlan {
  wrapper: string;
  request: CadData;
  context: CadContext;
  profile: "document-status" | "full" | "camera-save";
}
/** Pure wrapper plan. Source loading, path mapping and bundling are adapters. */
export function planCadScript(
  operation: string,
  data: CadData,
  context: CadContext,
  entry: OperationDeclaration,
  pythonLiteral: (value: unknown) => string,
  privateReadback?: CadPrivateReadback,
  cameraAlias?: CameraAliasObservation,
): CadScriptPlan {
  if (
    cameraAlias &&
    (operation !== "camera.save" ||
      context.component !== cameraAlias.name ||
      !cameraAlias.docId ||
      (context.docId != null && context.docId !== cameraAlias.docId))
  )
    throw new Error(
      "Camera alias continuation does not match the requested target",
    );
  if (
    privateReadback !== undefined &&
    (privateReadback !== "param-checkpoint" ||
      operation !== "param.inspect" ||
      entry.readOnly !== true ||
      data["includeModel"] !== true ||
      Object.keys(data).length !== 1 ||
      typeof context.docId !== "string" ||
      !context.docId.trim() ||
      context.component != null)
  )
    throw new Error(
      "Checkpoint readback requires an exact whole-document full parameter inspection",
    );
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
  const streamGuard = `    # Fail before touching Fusion if the host has leaked nested output wrappers.
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
            current = attributes['_original']`;
  if (operation === "camera.save") {
    // The validated invocation is immutable: no runtime registry lookup,
    // activation, result-status dispatch, or SDK-object projection is reachable.
    const args = [
      context.doc,
      null,
      context.projectId,
      cameraAlias?.docId ?? context.docId,
      context.docFileId,
    ].map((value) => pythonLiteral(value ?? null));
    const selector =
      typeof context.component === "string"
        ? pythonLiteral(context.component)
        : null;
    const selection = !selector
      ? ""
      : cameraAlias
        ? `    _camera_resume_component_name(ctx, ${selector}, ${pythonLiteral(cameraAlias.raw)}, lambda raw: _camera_resolve_alias(ctx, raw))\n`
        : `    alias = _camera_try_component_name(ctx, ${selector})
    if alias is not None:
        print('FMCAD_RESULT ' + json.dumps({'operation': 'camera.save', 'document': ctx.doc.name, '_cameraAlias': {'name': ${selector}, 'raw': alias, 'docId': ctx.doc.creationId}}))
        return
`;
    if (Object.keys(data).length)
      throw new Error(
        "Unknown CAD inputs: " + Object.keys(data).sort().join(", "),
      );
    const name = pythonLiteral(context.doc ?? null);
    if (typeof context.doc !== "string" || !context.doc.trim())
      throw new Error("doc_name must be an explicit document name");
    const docId = cameraAlias?.docId ?? context.docId;
    const pinChecks = (
      [
        [docId, "doc-id", "doc.creationId"],
        [context.docFileId, "doc-file-id", "_document_file_pin(doc)"],
      ] as const
    )
      .filter(([value]) => value != null)
      .map(([value, label, actual]) => {
        if (!value || /\s/.test(value) || value.startsWith("-"))
          throw new Error(
            label + " requires a nonempty identity without whitespace",
          );
        return `    _document_check_pin(doc, '${label}', ${pythonLiteral(value)}, ${actual})\n`;
      })
      .join("");
    const locate = selector
      ? `    ctx = CadContext(${args.join(", ")})
${selection}    ctx.assert_identity()
    app, doc = ctx.app, ctx.doc
`
      : `    app = adsk.core.Application.get()
    collection = app.documents
    docs = _document_named_top_level([collection.item(i) for i in range(collection.count)], ${name})
${context.projectId == null ? "" : `    docs = [doc for doc in docs if doc.dataFile and doc.dataFile.parentProject.id == ${pythonLiteral(context.projectId)}]\n`}    doc = _cad_cast('adsk.core.Document', _document_unique_name(docs, ${name}))
${pinChecks}    if _cad_cast('_DesignCaster', adsk.fusion.Design).cast(doc.products.itemByProductType('DesignProductType')) is None:
        raise ValueError('Document has no Fusion Design product: ' + ${name})
`;
    return {
      request,
      context,
      profile: "camera-save",
      wrapper: `def run(_context: str):
${streamGuard}
    import json
${locate}    print('FMCAD_PROGRESS ' + json.dumps({'operation': 'camera.save', 'document': doc.name, 'state': 'started'}))
    result = _camera_read(app, doc)
    try:
        encoded = json.dumps({'success': True, 'operation': 'camera.save', 'document': doc.name, 'result': result, 'created': []}, allow_nan=False)
    except ValueError as error:
        raise ValueError('Non-finite value cannot be serialized') from error
    print('FMCAD_RESULT ' + encoded)
`,
    };
  }
  const wrapper =
    minimal +
    `\n\n${requestType}
_FMCAD_REQUEST: "_FMCADRequest" = ${pythonLiteral(request)}

def run(_context: str):
${streamGuard}
    request = _FMCAD_REQUEST
    ctx = CadContext(request['doc'], request.get('component'), request.get('projectId'), request.get('docId'), request.get('docFileId'))
    if ${entry.readOnly || operation === "document.clear" || operation === "document.save_native" || operation === "selection.highlight" || (operation.startsWith("camera.") && operation !== "camera.set") || operation === "shot.pack" ? "False" : "True"}:
        ctx.activate_target()
    ctx.assert_identity()
    print('FMCAD_PROGRESS ' + json.dumps({'operation': request['operation'], 'document': ctx.doc.name, 'state': 'started'}))
    result = ${privateReadback === "param-checkpoint" ? "_cad_param_checkpoint(ctx)" : `ctx.call(${pythonLiteral(operation)}, request['data'])`}
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
