"""Read-only projection of the hash-pinned fmcad atomic-holder v1 ABI.

This unit deliberately has no command creation, activation, cleanup, execution,
model mutation or replay capability. The normal atomic dispatcher and scoped
observer share this reader; transactional atomic.py remains byte-identical.
"""

import re as _atomic_status_re
import sys as _atomic_status_sys
from collections.abc import Mapping as _AtomicStatusMapping
from collections.abc import Sequence as _AtomicStatusSequence
from typing import NamedTuple as _AtomicStatusNamedTuple
from typing import Protocol as _AtomicStatusProtocol
from typing import TypeAlias as _AtomicStatusTypeAlias
from typing import Union as _AtomicStatusUnion
from typing import cast as _atomic_status_cast


AtomicStatusJson: _AtomicStatusTypeAlias = _AtomicStatusUnion[
    None, bool, int, float, str, list['AtomicStatusJson'], dict[str, 'AtomicStatusJson']
]
AtomicStatusObject: _AtomicStatusTypeAlias = dict[str, AtomicStatusJson]


class _AtomicStatusDataFile(_AtomicStatusProtocol):
    @property
    def id(self) -> str: ...


class _AtomicStatusDocument(_AtomicStatusProtocol):
    @property
    def name(self) -> str: ...
    @property
    def creationId(self) -> str | None: ...
    @property
    def dataFile(self) -> _AtomicStatusDataFile | None: ...
    @property
    def isValid(self) -> bool: ...


class _AtomicStatusDocuments(_AtomicStatusProtocol):
    @property
    def count(self) -> int: ...
    def item(self, index: int) -> _AtomicStatusDocument: ...


class _AtomicStatusDefinition(_AtomicStatusProtocol):
    @property
    def id(self) -> str: ...
    @property
    def isNative(self) -> bool: ...
    @property
    def isValid(self) -> bool: ...


class _AtomicStatusDefinitions(_AtomicStatusProtocol):
    def itemById(self, identifier: str) -> _AtomicStatusDefinition | None: ...


class _AtomicStatusUi(_AtomicStatusProtocol):
    @property
    def activeCommand(self) -> str: ...
    @property
    def commandDefinitions(self) -> _AtomicStatusDefinitions: ...


class AtomicStatusApplication(_AtomicStatusProtocol):
    @property
    def documents(self) -> _AtomicStatusDocuments | _AtomicStatusSequence[_AtomicStatusDocument]: ...
    @property
    def userInterface(self) -> _AtomicStatusUi: ...


class _AtomicStatusHolder(_AtomicStatusProtocol):
    @property
    def identity(self) -> _AtomicStatusMapping[str, AtomicStatusJson]: ...
    @property
    def state(self) -> _AtomicStatusMapping[str, AtomicStatusJson]: ...
    @property
    def definitionId(self) -> str: ...


class _AtomicStatusResolution(_AtomicStatusNamedTuple):
    status: str
    resolved_identity: AtomicStatusObject | None
    candidates: list[AtomicStatusJson]
    unavailable: list[AtomicStatusJson]


def _atomic_status_object(value: AtomicStatusJson) -> AtomicStatusObject:
    if not isinstance(value, dict):
        raise ValueError('Atomic status requires a JSON object identity')
    return value


def _atomic_status_string(args: AtomicStatusObject, key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError('Atomic status requires a pinned ' + key)
    return value


def _atomic_status_document_identity(doc: _AtomicStatusDocument) -> AtomicStatusObject:
    try:
        if doc.isValid is False:
            raise ValueError('Open document handle is no longer valid')
    except AttributeError:
        pass
    try:
        creation_id = doc.creationId
    except AttributeError:
        creation_id = None
    try:
        data_file = doc.dataFile
    except AttributeError:
        data_file = None
    return {'name': doc.name, 'creationId': creation_id,
            'fileId': data_file.id if data_file is not None else None}


def _atomic_status_resolve(app: AtomicStatusApplication, expected: AtomicStatusObject) -> _AtomicStatusResolution:
    collection = app.documents
    documents = (list(collection) if isinstance(collection, _AtomicStatusSequence)
                 else [collection.item(index) for index in range(collection.count)])
    rows: list[AtomicStatusObject] = []
    failures: list[AtomicStatusJson] = []
    for doc in documents:
        try:
            rows.append(_atomic_status_document_identity(doc))
        except Exception as error:
            failures.append(type(error).__name__)
    wanted = _atomic_status_object(expected.get('expected', {}))
    if wanted.get('fileId') is not None:
        same_file = [row for row in rows if row['fileId'] == wanted['fileId']]
        if len(same_file) > 1:
            return _AtomicStatusResolution('ambiguous', None, list(same_file),
                ['unique open buffer for pinned fileId'] + failures)
    if failures:
        return _AtomicStatusResolution('unavailable', None, list(rows),
            ['document identity getter failed'] + failures)
    candidates = [row for row in rows if row['name'] == wanted.get('name') and
        (wanted.get('creationId') is None or row['creationId'] == wanted['creationId']) and
        (wanted.get('fileId') is None or row['fileId'] == wanted['fileId'])]
    if len(candidates) != 1:
        return _AtomicStatusResolution('ambiguous' if len(candidates) > 1 else 'unavailable',
            None, list(candidates), ['unique open document identity'])
    return _AtomicStatusResolution('resolved', candidates[0], list(candidates), [])


def atomic_status_readonly(app: AtomicStatusApplication, args: AtomicStatusObject) -> AtomicStatusObject:
    """Read the same v1 identity/state as atomic.py, without a writer capability."""
    if args.get('operation') != 'atomic_status':
        raise ValueError('This reader permits atomic_status only')
    command_id = _atomic_status_string(args, 'commandId')
    session_nonce = _atomic_status_string(args, 'sessionNonce')
    if not _atomic_status_re.fullmatch(r'fmcad_atomic_[0-9a-f]{32}', command_id) or \
            not _atomic_status_re.fullmatch(r'[0-9a-f]{32}', session_nonce):
        raise ValueError('Atomic status requires an exact command/session identity')
    module = _atomic_status_sys.modules.get('_fmcad_' + command_id)
    if module is None:
        return {'status': 'unavailable', 'accepted': None, 'completed': False,
                'destroyed': False, 'cleanupCompleted': False, 'definitionDeleted': False,
                'outcome': 'unknown', 'error': 'Live atomic batch state lost; inspect model, never replay'}
    # The broker independently verifies every original v1 source-unit hash.
    # This is a precise read-only ABI protocol, not an Any model of the holder.
    holder = _atomic_status_cast(_AtomicStatusHolder, module)
    expected: AtomicStatusObject = {
        'commandId': command_id, 'runId': _atomic_status_string(args, 'runId'),
        'requestHash': _atomic_status_string(args, 'requestHash'),
        'backend': _atomic_status_string(args, 'backend'), 'sessionNonce': session_nonce,
        'documentIdentity': args.get('documentIdentity'),
    }
    if any(holder.identity.get(key) != value for key, value in expected.items()):
        return {'status': 'identity_mismatch', 'accepted': None, 'completed': False,
                'destroyed': False, 'cleanupCompleted': False, 'definitionDeleted': False,
                'outcome': 'unknown', 'error': 'Atomic holder identity mismatch; no cleanup performed'}
    resolved = _atomic_status_resolve(app, _atomic_status_object(expected['documentIdentity']))
    state = dict(holder.state)
    if resolved.status != 'resolved' or resolved.resolved_identity != holder.identity.get('resolvedIdentity'):
        state.update(status=resolved.status if resolved.status != 'resolved' else 'identity_mismatch',
            ambiguous=resolved.status == 'ambiguous', candidates=resolved.candidates,
            unavailableEvidence=resolved.unavailable, identity=dict(holder.identity),
            cleanupCompleted=False, definitionDeleted=False)
        return state
    state.update(identity=dict(holder.identity), idle=app.userInterface.activeCommand in ('', 'SelectCommand'),
        cleanupCompleted=holder.state.get('cleanupCompleted', False),
        definitionDeleted=holder.state.get('definitionDeleted', False))
    if not state['cleanupCompleted']:
        definition = app.userInterface.commandDefinitions.itemById(command_id)
        if definition is None:
            state.update(status='unavailable', outcome='unknown', unavailableEvidence=['owned native command lifetime'])
            return state
        try:
            valid = definition.isValid
        except AttributeError:
            valid = True
        if valid is False or definition.isNative or definition.id != holder.definitionId:
            state.update(status='unavailable', outcome='unknown', unavailableEvidence=['owned native command lifetime'])
    return state
