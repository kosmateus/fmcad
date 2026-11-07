"""One explicitly requested new empty document; never adopt/close existing docs."""
import os as _ep_os
import re as _ep_re
from typing import Protocol as _EpProtocol


class _EpDocument(_AaDoc, _EpProtocol):
    @property
    def name(self) -> str: ...
    @name.setter
    def name(self, value: str) -> None: ...
    def close(self, saveChanges: bool) -> bool: ...
    def activate(self) -> bool: ...


class _EpDocuments(_AaDocs, _EpProtocol):
    def add(self, document_type: object) -> _EpDocument | None: ...
    def item(self, index: int) -> _EpDocument: ...


class EpochApplication(_EpProtocol):
    @property
    def documents(self) -> _EpDocuments: ...
    @property
    def userInterface(self) -> _AaUi: ...
    @property
    def activeDocument(self) -> _EpDocument | None: ...


def _ep_write(path: str, value: AaObject) -> None:
    # The directory is broker-owned. Exclusive creation never replaces evidence.
    with open(path, 'x', encoding='utf-8') as file:
        _aa_json.dump(value, file, allow_nan=False)
        file.flush()
        _ep_os.fsync(file.fileno())


def qualify_new_scratch(app: EpochApplication, args: AaObject) -> AaObject:
    import adsk.core
    import adsk.fusion
    epoch_id, name, proof_path, binding_hash = (args.get(k) for k in ('epochId', 'name', 'proofPath', 'bindingHash'))
    forbidden = args.get('forbiddenIds')
    if not isinstance(epoch_id, str) or not _ep_re.fullmatch(r'[a-f0-9-]{36}', epoch_id) or \
            not isinstance(name, str) or name != 'FMCAD_ISOLATED_' + epoch_id or not isinstance(proof_path, str) or not isinstance(binding_hash, str) or \
            not isinstance(forbidden, list) or not forbidden or any(not isinstance(value, str) or not value for value in forbidden):
        raise ValueError('Exact broker-derived scratch intent required')
    if app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise ValueError('New scratch qualification requires an idle current instance')
    docs = app.documents
    count = docs.count
    if count < 0 or count > 256:
        raise ValueError('Open document identity bound exceeded')
    before = {docs.item(i).creationId for i in range(count)}
    if len(before) != count or any(not value for value in before):
        raise ValueError('Complete distinct pre-existing document identities required')
    if any(docs.item(i).name == name for i in range(count)):
        raise ValueError('Scratch name already exists; never adopt or replay')
    capture_active = args.get('captureActiveDocument') is True
    previous_active_id: str | None = None
    if capture_active:
        active = app.activeDocument
        if active is not None:
            if not active.isValid or active.creationId not in before:
                raise ValueError('The previously active document identity is unavailable')
            previous_active_id = active.creationId
    _ep_write(proof_path + '.started', {'epochId': epoch_id, 'bindingHash': binding_hash})
    doc = docs.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    if doc is None:
        raise RuntimeError('New document result unavailable; never repeat creation')
    new_id = doc.creationId
    # Do not rename/touch a returned old document, even if the SDK double lies.
    if not new_id or new_id in before or new_id in forbidden or docs.count != count + 1:
        raise RuntimeError('New document independence not established')
    after = {docs.item(i).creationId for i in range(count + 1)}
    if after != before | {new_id} or doc.isSaved or doc.dataFile is not None:
        raise RuntimeError('New document namespace or unsaved state not established')
    _ep_write(proof_path + '.created', {'epochId': epoch_id, 'bindingHash': binding_hash, 'creationId': new_id})
    doc.name = name
    design = _aa_cast(_AaDesignType, adsk.fusion.Design).cast(doc.products.itemByProductType('DesignProductType'))
    if design is None:
        raise RuntimeError('Fresh scratch has no design')
    counts = [design.rootComponent.bRepBodies.count, design.rootComponent.sketches.count,
              design.rootComponent.allOccurrences.count, design.userParameters.count,
              design.timeline.count, doc.allDocumentReferences.count]
    if any(value != 0 for value in counts) or not doc.isValid or doc.name != name or \
            doc.creationId != new_id or doc.isSaved or doc.dataFile is not None or \
            app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise RuntimeError('Fresh scratch invariants not observed; retain creation evidence, never replay')
    result: AaObject = {'version': 1, 'purpose': 'isolated-scratch-epoch-v1', 'epochId': epoch_id,
        'bindingHash': binding_hash, 'document': {'name': name, 'creationId': new_id, 'fileId': None},
        'independent': True, 'empty': True, 'unsaved': True,
        'activeCommand': app.userInterface.activeCommand,
        'beforeIdsHash': _aa_hashlib.sha256(_aa_json.dumps(sorted(before), separators=(',', ':')).encode()).hexdigest(),
        'historicalOutcome': 'unknown', 'originalModelValidation': 'not_performed',
        'originalRollbackVerification': 'not_performed'}
    if capture_active:
        result['previousActiveCreationId'] = previous_active_id
    _ep_write(proof_path, result)
    return result


def close_qualified_scratch(app: EpochApplication, args: AaObject) -> AaObject:
    identity, proof_path, binding_hash = (args.get(k) for k in ('document', 'proofPath', 'bindingHash'))
    epoch_id = args.get('epochId')
    if not isinstance(identity, dict) or not isinstance(proof_path, str) or not isinstance(binding_hash, str) or \
            identity.get('fileId') is not None or not isinstance(identity.get('creationId'), str) or not identity['creationId'] or \
            not isinstance(epoch_id, str) or not _ep_re.fullmatch(r'[a-f0-9-]{36}', epoch_id) or \
            identity.get('name') != 'FMCAD_ISOLATED_' + epoch_id:
        raise ValueError('Broker-qualified exact unsaved scratch identity required')
    docs = app.documents
    count = docs.count
    if count < 1 or count > 256 or app.userInterface.activeCommand not in ('', 'SelectCommand'):
        raise ValueError('Scratch close requires a bounded idle current instance')
    before = {docs.item(i).creationId for i in range(count)}
    matches = [docs.item(i) for i in range(count) if docs.item(i).creationId == identity['creationId']]
    if len(before) != count or len(matches) != 1:
        raise ValueError('Qualified scratch identity is absent or ambiguous; never adopt another doc')
    doc = matches[0]
    if not doc.isValid or _aa_identity(doc) != identity or doc.isSaved or doc.dataFile is not None or doc.allDocumentReferences.count:
        raise ValueError('Qualified scratch was renamed/saved/linked or identity changed; do not discard')
    restore_requested = 'restoreActiveCreationId' in args
    restore_id = args.get('restoreActiveCreationId')
    active_before_id: str | None = None
    if restore_requested:
        if restore_id is not None and (not isinstance(restore_id, str) or not restore_id or restore_id == identity['creationId']):
            raise ValueError('Only the captured pre-scratch document identity may be restored')
        active_before = app.activeDocument
        active_before_id = active_before.creationId if active_before is not None else None
    _ep_write(proof_path + '.started', {'document': identity, 'bindingHash': binding_hash})
    if doc.close(False) is not True:
        raise RuntimeError('Scratch close result uncertain; never replay')
    after = {docs.item(i).creationId for i in range(docs.count)}
    if docs.count != count - 1 or after != before - {str(identity['creationId'])}:
        raise RuntimeError('Exact scratch-only close not established; retain evidence, never replay')
    restored_id: str | None = None
    if restore_requested:
        # Preserve a user-selected different document; otherwise restore only the
        # exact identity captured before this owned scratch was created.
        target_id = restore_id if active_before_id == identity['creationId'] else active_before_id
        if target_id is not None:
            targets = [docs.item(i) for i in range(docs.count) if docs.item(i).creationId == target_id]
            if len(targets) != 1 or not targets[0].isValid:
                raise RuntimeError('Captured restore document is absent; never adopt another document')
            active_after = app.activeDocument
            if active_after is None or not active_after.isValid or active_after.creationId != target_id:
                if targets[0].activate() is not True:
                    raise RuntimeError('Previously active document restoration failed')
        active_final = app.activeDocument
        restored_id = active_final.creationId if active_final is not None else None
        if restored_id != target_id:
            raise RuntimeError('Active document restoration was not observed')
    result: AaObject = {'version': 1, 'purpose': 'isolated-scratch-close-v1', 'document': identity,
        'bindingHash': binding_hash, 'closed': True, 'saved': False, 'historicalOutcome': 'unknown',
        'originalModelValidation': 'not_performed', 'originalRollbackVerification': 'not_performed'}
    if restore_requested:
        result['activeBeforeCloseCreationId'] = active_before_id
        result['restoredActiveCreationId'] = restored_id
        result['activeDocumentRestored'] = True
    _ep_write(proof_path, result)
    return result
