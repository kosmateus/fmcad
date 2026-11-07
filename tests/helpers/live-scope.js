'use strict';

const fs = require('node:fs');
let name = process.env.FMCAD_LIVE_FIXTURE_NAME || null;
let id = process.env.FMCAD_LIVE_FIXTURE_ID || null;

function fixture(documentName, creationId = null) { name = documentName; id = creationId; }
function environment() {
  return { ...(name ? { FMCAD_LIVE_FIXTURE_NAME: name } : {}), ...(id ? { FMCAD_LIVE_FIXTURE_ID: id } : {}) };
}
function source(code) {
  const baseline = process.env.FMCAD_LIVE_BASELINE_FILE
    ? JSON.parse(fs.readFileSync(process.env.FMCAD_LIVE_BASELINE_FILE, 'utf8')) : null;
  const ids = baseline?.documents.map(doc => doc.creationId) || null;
  let prefix = `\ndef _fmcad_live_visible(d):\n    return ` + (ids ?
    `d.creationId in ${JSON.stringify(ids)} or d.name == ${name ? JSON.stringify(name) : 'None'} or d.name.startswith(${JSON.stringify((name || '\0') + '_')})` : 'True') + '\n';
  const target = id || baseline?.activeCreationId;
  if (target) prefix += `import adsk.core as _fmcad_scope_core
_fmcad_scope_app = _fmcad_scope_core.Application.get()
_fmcad_scope_matches = [d for d in _fmcad_scope_app.documents if d.creationId == ${JSON.stringify(target)}]
${id ? "assert len(_fmcad_scope_matches) == 1, 'Owned live fixture disappeared; no test operation started'\n" : ''}
if len(_fmcad_scope_matches) == 1 and _fmcad_scope_app.userInterface.activeCommand in ('', 'SelectCommand'):
    _fmcad_scope_doc = _fmcad_scope_matches[0]
    ${id ? `if _fmcad_scope_doc.creationId == ${JSON.stringify(id)}:
        assert _fmcad_scope_doc.name == ${JSON.stringify(name)} and not _fmcad_scope_doc.isSaved, 'Owned live fixture identity changed'` : 'pass'}
    if _fmcad_scope_app.activeDocument != _fmcad_scope_doc:
        assert _fmcad_scope_doc.activate(), 'Live fixture activation failed'
`;
  return prefix + '\n' + code;
}
function payload(value) {
  const request = value.params;
  if (request?.name === 'execute_python' && typeof request.arguments?.code === 'string') {
    return { ...value, params: { ...request, arguments: { ...request.arguments, code: source(request.arguments.code) } } };
  }
  if (request?.name === 'fusion_mcp_execute' && request.arguments?.featureType === 'script') {
    return { ...value, params: { ...request, arguments: { ...request.arguments,
      object: { ...request.arguments.object, script: source(request.arguments.object.script) } } } };
  }
  return value;
}

module.exports = { fixture, environment, source, payload };
