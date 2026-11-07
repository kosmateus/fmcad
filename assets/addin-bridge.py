import json
import unicodedata
import adsk.core

_BRIDGE_REQUEST = {}


def _unsupported(detail):
    raise RuntimeError(detail + ' is unsupported by the addin bridge; use --backend mcp explicitly. No automatic fallback is performed.')


def _normalize(text):
    return unicodedata.normalize('NFKC', text).casefold()


def run(_context: str):
    tool = _BRIDGE_REQUEST['toolName']
    req = _BRIDGE_REQUEST['request']
    app = adsk.core.Application.get()
    if tool == 'fusion_mcp_read':
        query = req.get('queryType')
        if query == 'projects':
            payload = {'success': True, 'projects': [
                {'name': p.name, 'id': p.id} for p in app.data.dataProjects.asArray()
            ]}
        elif query == 'activeCommand':
            command_id = app.userInterface.activeCommand
            payload = {
                'success': True,
                'activeCommand': {'id': command_id} if command_id else None,
                'partial': True,
                'limitations': 'Only the active command ID is exposed here; name, tooltip, default-command status and live inputs are unavailable.',
            }
        elif query == 'document':
            operation = req.get('operation')
            results = []
            if operation == 'open':
                for doc in app.documents:
                    row = {'name': doc.name, 'isActive': doc.isActive,
                           'isSaved': doc.isSaved, 'isModified': doc.isModified}
                    creation_id = getattr(doc, 'creationId', None)
                    if creation_id is not None:
                        row['creationId'] = creation_id
                    file, error = _document_data_file(doc) if doc.isSaved else (None, None)
                    if file is not None:
                        row['id'] = file.id
                    if error:
                        row['dataFileError'] = error
                    results.append(row)
            elif operation == 'search':
                name = req.get('name')
                project = req.get('project')
                if not isinstance(name, str) or not name.strip():
                    raise ValueError('Search requires a nonempty name')
                if project is not None and (not isinstance(project, str) or not project.strip()):
                    raise ValueError('Project must be a nonempty name or id')
                projects = app.data.dataProjects.asArray()
                if project is not None:
                    by_id = [p for p in projects if p.id == project]
                    projects = by_id or [p for p in projects if _normalize(p.name) == _normalize(project)]
                    if not projects:
                        raise ValueError('Project not found: ' + project)
                    if len(projects) != 1:
                        raise ValueError('Ambiguous project name; specify the project id')
                needle = _normalize(name)
                folders = [p.rootFolder for p in projects]
                while folders:
                    folder = folders.pop()
                    for data_file in folder.dataFiles.asArray():
                        if needle in _normalize(data_file.name):
                            results.append({'name': data_file.name, 'id': data_file.id})
                    folders.extend(folder.dataFolders.asArray())
            else:
                # The installed documented Data API does not expose recentFiles.
                _unsupported('Document read ' + str(operation))
            payload = {'success': True, 'results': results}
            if operation == 'open' and any(row.get('dataFileError') for row in results):
                payload['partial'] = True
        else:
            _unsupported('Read ' + str(query))
    elif tool == 'fusion_mcp_execute':
        if req.get('featureType') != 'document':
            _unsupported('Execute ' + str(req.get('featureType')))
        obj = req.get('object')
        if not isinstance(obj, dict):
            raise ValueError('Document operation requires an object')
        operation = obj.get('operation')
        if operation == 'open':
            file_id = obj.get('fileId')
            if not isinstance(file_id, str) or not file_id.strip():
                raise ValueError('Document open requires fileId')
            data_file = app.data.findFileById(file_id)
            if data_file is None:
                raise RuntimeError('File not found or inaccessible: ' + file_id)
            if app.documents.open(data_file) is None:
                raise RuntimeError('Document open failed')
        elif operation in ('save', 'close'):
            save = operation == 'save'
            if operation == 'close':
                for flag in ('userConfirmedSaveAndClose', 'userConfirmedCloseWithoutSave'):
                    if flag in obj and type(obj[flag]) is not bool:
                        raise ValueError(flag + ' must be boolean')
                save = obj.get('userConfirmedSaveAndClose') is True
                discard = obj.get('userConfirmedCloseWithoutSave') is True
                if save == discard:
                    raise ValueError('Document close requires exactly one save or discard confirmation')
            doc = app.activeDocument
            if doc is None:
                raise RuntimeError('No active document')
            if save:
                if not doc.isSaved:
                    raise RuntimeError('New document has no save target; save it with an explicit name and location in Fusion first')
                if doc.save('') is not True:
                    raise RuntimeError('Document save failed; document was not closed')
                if operation == 'close' and doc.isModified:
                    raise RuntimeError('Document still has unsaved changes; document was not closed')
            # close(True) prompts rather than guaranteeing a save. Save explicitly first.
            if operation == 'close' and doc.close(False) is not True:
                raise RuntimeError('Document close failed')
        else:
            _unsupported('Document execute ' + str(operation))
        payload = {'success': True, 'message': 'Document ' + {'open': 'opened', 'save': 'saved', 'close': 'closed'}[operation] + ' successfully'}
    else:
        _unsupported('Tool ' + str(tool))
    print('FMCAD_BRIDGE_RESULT ' + json.dumps(payload))
