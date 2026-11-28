"""Owner-scoped present facts only. No command/activation/model writer exists here."""
import hashlib as _aa_hashlib
import json as _aa_json
import sys as _aa_sys
from typing import Protocol as _AaProtocol, TypeAlias as _AaAlias, Union as _AaUnion, cast as _aa_cast

AaJson: _AaAlias = _AaUnion[None, bool, int, float, str, list['AaJson'], dict[str, 'AaJson']]
AaObject: _AaAlias = dict[str, AaJson]


class _AaCount(_AaProtocol):
    @property
    def count(self) -> int: ...


class _AaFile(_AaProtocol):
    @property
    def id(self) -> str: ...
    @property
    def versionNumber(self) -> int: ...


class _AaProducts(_AaProtocol):
    def itemByProductType(self, name: str) -> object: ...


class _AaDoc(_AaProtocol):
    @property
    def name(self) -> str: ...
    @property
    def creationId(self) -> str: ...
    @property
    def dataFile(self) -> _AaFile | None: ...
    @property
    def isSaved(self) -> bool: ...
    @property
    def isModified(self) -> bool: ...
    @property
    def isValid(self) -> bool: ...
    @property
    def products(self) -> _AaProducts: ...
    @property
    def allDocumentReferences(self) -> _AaCount: ...


class _AaDocs(_AaCount, _AaProtocol):
    def item(self, index: int) -> _AaDoc: ...


class _AaDefinition(_AaProtocol):
    @property
    def id(self) -> str: ...
    @property
    def isNative(self) -> bool: ...
    @property
    def isValid(self) -> bool: ...


class _AaDefinitions(_AaProtocol):
    def itemById(self, name: str) -> _AaDefinition | None: ...


class _AaUi(_AaProtocol):
    @property
    def activeCommand(self) -> str: ...
    @property
    def commandDefinitions(self) -> _AaDefinitions: ...


class AaApplication(_AaProtocol):
    @property
    def documents(self) -> _AaDocs: ...
    @property
    def userInterface(self) -> _AaUi: ...


class _AaComponent(_AaProtocol):
    @property
    def bRepBodies(self) -> _AaCount: ...
    @property
    def sketches(self) -> _AaCount: ...
    @property
    def allOccurrences(self) -> _AaCount: ...


class _AaDesign(_AaProtocol):
    @property
    def rootComponent(self) -> _AaComponent: ...
    @property
    def timeline(self) -> _AaCount: ...
    @property
    def userParameters(self) -> _AaCount: ...


class _AaDesignType(_AaProtocol):
    def cast(self, value: object) -> _AaDesign | None: ...


def _aa_identity(doc: _AaDoc) -> AaObject:
    if not doc.isValid:
        raise ValueError('Invalid document handle')
    file = doc.dataFile
    return {'name': doc.name, 'creationId': doc.creationId, 'fileId': file.id if file else None}


def atomic_recovery_audit(app: AaApplication, args: AaObject) -> AaObject:
    import adsk.fusion
    identity = args.get('identity')
    if not isinstance(identity, dict):
        raise ValueError('Broker-derived identity required')
    command_id = identity.get('commandId')
    document = identity.get('resolvedIdentity')
    if not isinstance(command_id, str) or not isinstance(document, dict):
        raise ValueError('Exact command and resolved document pins required')
    result: AaObject = {'version': 1, 'purpose': 'atomic-recovery-audit-v1',
        'profile': 'atomic-recovery-counts-v1', 'requestIdentity': identity,
        'nativeOutcome': 'unknown', 'modelValidation': 'not_performed',
        'rollbackVerification': 'not_performed', 'modulePresent': '_fmcad_' + command_id in _aa_sys.modules,
        'ui': None, 'commandDefinition': None, 'document': None, 'snapshot': None, 'fingerprint': None}
    try:
        active = app.userInterface.activeCommand
        result['ui'] = {'activeCommand': active[:256], 'idle': active in ('', 'SelectCommand')}
    except Exception as error:
        result['ui'] = {'status': 'unavailable', 'errorType': type(error).__name__}
    try:
        definition = app.userInterface.commandDefinitions.itemById(command_id)
        result['commandDefinition'] = {'status': 'absent'} if definition is None else {
            'status': 'owned' if definition.id == command_id and not definition.isNative and definition.isValid else 'foreign_or_invalid',
            'idMatches': definition.id == command_id, 'isNative': definition.isNative, 'isValid': definition.isValid}
    except Exception as error:
        result['commandDefinition'] = {'status': 'unavailable', 'errorType': type(error).__name__}
    try:
        collection = app.documents
        count = collection.count
        if count < 0 or count > 256:
            raise ValueError('Open document identity scan exceeds fixed audit bound')
        candidates: list[_AaDoc] = []
        # Enumerate identities only, never expose any non-target document data.
        for index in range(count):
            doc = collection.item(index)
            if _aa_identity(doc) == document:
                candidates.append(doc)
        if len(candidates) != 1:
            result['document'] = {'status': 'ambiguous' if candidates else 'absent', 'matches': len(candidates)}
            return result
        target = candidates[0]
        first = _aa_identity(target)
        result['document'] = {'status': 'observed', 'identity': first}
        design_type = _aa_cast(_AaDesignType, adsk.fusion.Design)
        design = design_type.cast(target.products.itemByProductType('DesignProductType'))
        if design is None:
            raise ValueError('Pinned document has no design')
        file = target.dataFile
        snapshot: AaObject = {'identity': first, 'version': file.versionNumber if file else None,
            'isSaved': target.isSaved, 'isModified': target.isModified,
            'bodies': design.rootComponent.bRepBodies.count, 'sketches': design.rootComponent.sketches.count,
            'occurrences': design.rootComponent.allOccurrences.count, 'parameters': design.userParameters.count,
            'timeline': design.timeline.count, 'references': target.allDocumentReferences.count}
        if _aa_identity(target) != first or (target.dataFile.versionNumber if target.dataFile else None) != snapshot['version']:
            raise ValueError('Document identity/version changed during audit')
        result['snapshot'] = snapshot
        encoded = _aa_json.dumps(snapshot, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        result['fingerprint'] = _aa_hashlib.sha256(encoded.encode('utf-8')).hexdigest()
    except Exception as error:
        result['document'] = {'status': 'unavailable', 'errorType': type(error).__name__}
        result['snapshot'] = None
        result['fingerprint'] = None
    return result
