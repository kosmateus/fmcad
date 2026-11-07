"""Cloud-copy request validation and result projection, using JSON values only."""


def document_copy_request(data: "JsonObject") -> "JsonRecord":
    name, project_ref, path = data['name'], data['project'], data['folder']
    if (not isinstance(name, str) or not name.strip() or name != name.strip()
            or name in ('.', '..') or any(c in name for c in '/\\:*?"<>|')
            or any(ord(c) < 32 for c in name) or name.endswith('.')):
        raise ValueError('name must be a nonempty document name, not a path, without reserved characters or edge whitespace/dots')
    if not isinstance(project_ref, str) or not project_ref.strip():
        raise ValueError('project must be an exact nonempty project ID or name')
    if (not isinstance(path, str) or '\\' in path or ':' in path
            or any(ord(c) < 32 for c in path)
            or (path != '' and any(p in ('', '.', '..') for p in path.split('/')))):
        raise ValueError('folder must be a relative cloud folder path separated by /; use empty string for root')
    description = data.get('description', '')
    if not isinstance(description, str):
        raise ValueError('description must be a string')
    tag = data.get('tag', '')
    if not isinstance(tag, str):
        raise ValueError('tag must be a string')
    request: JsonRecord = {'name': name, 'project': project_ref, 'folder': path,
                           'description': description, 'tag': tag}
    if 'expectedFolderId' in data:
        folder_id = data['expectedFolderId']
        if not isinstance(folder_id, str) or not folder_id.strip():
            raise ValueError('expectedFolderId must be a nonempty exact folder ID')
        request['expectedFolderId'] = folder_id
    if 'expectedProjectId' in data:
        project_id = data['expectedProjectId']
        if not isinstance(project_id, str) or not project_id.strip():
            raise ValueError('expectedProjectId must be a nonempty exact native project ID')
        request['expectedProjectId'] = project_id
    return request


def document_copy_result(accepted: object, original: "JsonRecord",
                         current: "JsonRecord | None", target: "JsonRecord",
                         warning: str, readback_error: "JsonValue | None" = None) -> "JsonRecord":
    observed = bool(current is not None and current['saved'] and current['fileId']
                    and current['fileId'] != original['fileId']
                    and current['fileName'] == target['name']
                    and current['projectId'] == target['projectId']
                    and current['folderId'] == target['folderId'])
    complete = bool(accepted and observed and current is not None and not current['modified']
                    and current['isComplete'] is True)
    result: JsonRecord = {'accepted': bool(accepted), 'pending': bool(accepted and not complete),
                          'status': 'complete' if complete else ('pending' if accepted else 'failed'),
                          'targetObserved': observed, 'original': original, 'current': current,
                          'target': target, 'copyRequested': bool(original['saved']), 'warning': warning}
    if readback_error is not None:
        result['readbackError'] = readback_error
    return result
