import type { OperationDeclaration } from "../../catalog";
import type { CadContext, CadData, CameraAliasObservation } from "./contracts";
import { cameraSelector } from "./camera-selector";

/** Compiler-only selection, never decoded from a public CAD invocation. */
export type CadPrivateReadback = "param-checkpoint";

export interface CameraAliasRoute {
  readonly receiver?: "design" | "context";
  readonly simpleContext?: boolean;
  readonly alwaysEligibleAliasTarget?: boolean;
  readonly validComponent?: boolean;
  readonly resolverSymbol: string;
  readonly aliasBindings: readonly {
    name: string;
    raw: string;
    resolverSymbol: string;
  }[];
  readonly mayDiscover: boolean;
}

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
  cameraRoute?: CameraAliasRoute,
): CadScriptPlan {
  if (
    cameraAlias &&
    (operation !== "camera.save" ||
      (typeof context.component === "string"
        ? context.component !== cameraAlias.name
        : !context.component ||
          cameraAlias.name !== "" ||
          cameraAlias.raw !== JSON.stringify(context.component)) ||
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
    const stage = cameraSelector(context, cameraAlias);
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
    const direct =
      context.component != null && typeof context.component === "object";
    let selection = "";
    if (stage.kind === "alias" || direct) {
      if (
        !cameraRoute ||
        ![
          cameraRoute.resolverSymbol,
          ...cameraRoute.aliasBindings.map((b) => b.resolverSymbol),
        ].every((symbol) =>
          /^_camera_(?:alias_[a-z_]+|token_[a-f0-9]{16})$/.test(symbol),
        )
      )
        throw new Error("Missing canonical camera alias callback");
      const raw = pythonLiteral(
        cameraAlias?.raw ?? JSON.stringify(context.component),
      );
      const resolveCall = selector
        ? `_camera_check_resumed_name(ctx, ${selector}, ${raw}, lambda raw: ${cameraRoute.resolverSymbol}(ctx, raw))`
        : `_camera_require_component(${cameraRoute.resolverSymbol}(ctx, ${raw}))`;
      if (cameraRoute.receiver === "design") {
        selection = selector
          ? `    root = design.rootComponent
    name = ${selector}
    if _camera_scope_attribute(root, name) != ${raw}:
        raise RuntimeError('DOCUMENT_STATE_CHANGED: component alias changed during selection')
    matches = _camera_matching_names(design, root, name)
    ${cameraRoute.alwaysEligibleAliasTarget ? `matches.append(${cameraRoute.resolverSymbol}(design))` : `_camera_add_root_match(root, matches, ${cameraRoute.resolverSymbol}(design))`}
    ${cameraRoute.validComponent ? "_cad_unique(matches, 'Reference ' + name)" : "_camera_require_component(_cad_unique(matches, 'Reference ' + name))"}
`
          : `    ${cameraRoute.validComponent ? `${cameraRoute.resolverSymbol}(design)` : `_camera_require_component(${cameraRoute.resolverSymbol}(design))`}\n`;
      } else {
        if (cameraRoute.aliasBindings.length)
          selection += `    setattr(ctx, '_camera_alias_bindings', {${cameraRoute.aliasBindings.map((b) => `${pythonLiteral(b.name)}: (${pythonLiteral(b.raw)}, ${b.resolverSymbol})`).join(", ")}})\n`;
        selection += cameraRoute.mayDiscover
          ? `    try:
        ${resolveCall}
    except _CameraAliasRequired as needed:
        print('FMCAD_RESULT ' + json.dumps({'operation':'camera.save', 'document':doc.name, '_cameraAlias':{'name':needed.name, 'raw':needed.raw, 'docId':doc.creationId}}))
        return
`
          : `    ${resolveCall}\n`;
      }
    }
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
        const expected = pythonLiteral(value);
        return `    expected = ${expected}
    actual = ${actual}
    if actual != expected:
        raise ValueError('${label} mismatch for document %s: expected %s, got %s' % (doc.name, expected, actual))
`;
      })
      .join("");
    const simple =
      cameraRoute?.simpleContext && cameraRoute.receiver !== "design";
    const complex =
      (stage.kind === "alias" || direct) &&
      !simple &&
      cameraRoute?.receiver !== "design";
    const locate = complex
      ? `    ctx = CadContext(${args.join(", ")})
    app, doc = ctx.app, ctx.doc
${selection}    ctx.assert_identity()
`
      : `    app = adsk.core.Application.get()
    collection = app.documents
    doc_name = ${name}
    doc = _cad_cast('adsk.core.Document', _document_unique_matching((collection.item(i) for i in range(collection.count)), doc_name${context.projectId == null ? "" : ", " + pythonLiteral(context.projectId)}))
${pinChecks}    ${stage.kind === "none" ? "if _cad_cast('_DesignCaster', adsk.fusion.Design).cast(doc.products.itemByProductType('DesignProductType')) is None:" : "design = _cad_cast('_DesignCaster', adsk.fusion.Design).cast(doc.products.itemByProductType('DesignProductType'))\n    if design is None:"}
        raise ValueError('Document has no Fusion Design product: ' + doc_name)
`;
    const preamble = streamGuard.replace(
      "for stream in (sys.stdout, sys.stderr):\n        current: object = stream",
      "current: object\n    for current in (sys.stdout, sys.stderr):",
    );
    if (stage.kind === "discover")
      return {
        request,
        context,
        profile: "camera-save",
        wrapper: `def run(_context: str):
${preamble}
    import json
${locate}    name = ${selector}
    alias = _camera_scope_attribute(design.rootComponent, name)
    print('FMCAD_RESULT ' + json.dumps({'operation':'camera.save','document':doc.name,'_cameraAlias':{'name':name,'raw':alias,'docId':doc.creationId}}))
`,
      };
    const confirm =
      stage.kind === "reserved"
        ? `    _camera_require_component(design.rootComponent${stage.property ? "." + stage.property : ""})\n`
        : stage.kind === "plain"
          ? `    root = design.rootComponent
    name = ${selector}
    if _camera_scope_attribute(root, name) is not None:
        raise RuntimeError('DOCUMENT_STATE_CHANGED: component alias changed during selection')
    _camera_require_component(_cad_unique(_camera_matching_names(design, root, name), 'Reference ' + name))
`
          : cameraRoute?.receiver === "design"
            ? selection
            : simple
              ? "    ctx = CadContext(design)\n" + selection
              : "";
    return {
      request,
      context,
      profile: "camera-save",
      wrapper: `def run(_context: str):
${preamble}
    import json
${locate}${confirm}    print('FMCAD_PROGRESS ' + json.dumps({'operation': 'camera.save', 'document': doc.name, 'state': 'started'}))
    result = {'state': _camera_pose(doc, _camera_active_viewport(app, doc).camera)}
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
