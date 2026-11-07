"""DTO-only rules extracted from assets/cad/externalization.py. No SDK or filesystem access."""
import hashlib as _external_hashlib
import json as _external_json
from typing import (
    NotRequired as _ExternalNotRequired,
    Protocol as _ExternalProtocol,
    Required as _ExternalRequired,
    TypedDict as _ExternalTypedDict,
)


if TYPE_CHECKING:
    class _ExternalDestination(_ExternalTypedDict):
        projectId: str
        folderId: str
        fileName: _ExternalNotRequired[str]
        name: _ExternalNotRequired[str]

    class _ExternalPin(_ExternalTypedDict):
        fileId: str
        projectId: str
        version: int
        creationId: _ExternalNotRequired[str]
        context: _ExternalNotRequired[str]

    class _ExternalCopyIntent(_ExternalTypedDict):
        destination: _ExternalDestination
        description: str
        operationId: str
        itemId: str
        purpose: str
        source: _ExternalPin
        nonce: str
        finalDescription: str
        component: JsonValue

    class _ExternalCopyEvent(_ExternalTypedDict, total=False):
        projectId: _ExternalRequired[str]
        folderId: _ExternalRequired[str]
        description: _ExternalRequired[str]
        fileId: _ExternalRequired[str]
        version: _ExternalRequired[int]
        event: _ExternalRequired[str]
        name: str
        isComplete: bool
        status: _ExternalRequired[JsonObject]
        statusReadContext: str
        statusReadError: str
        statusReadErrorAt: str

    _ExternalValue = TypeVar('_ExternalValue')

    class _ExternalAttributed(_ExternalProtocol):
        @property
        def attributes(self) -> "adsk.core.Attributes": ...

_EXTERNAL_PROBE_RESTORE_RESERVE_MS = 60000


def _external_require(value: "_ExternalValue", message: str) -> "_ExternalValue":
    if not value:
        raise ValueError(message)
    return value


def _external_digest(value: "JsonValue") -> str:
    return _external_hashlib.sha256(_external_json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _external_event_matches(intent: "_ExternalCopyIntent", event: "_ExternalCopyEvent") -> bool:
    destination=intent['destination']
    return (event.get('projectId')==destination['projectId'] and event.get('folderId')==destination['folderId'] and
            event.get('description')==intent['description'])


def _external_next_saved_name(name: str, version: int) -> str:
    import re
    match=re.fullmatch(r'(.+) v(\d+)',str(name))
    if match is None or int(match.group(2))!=int(version):
        raise ValueError('Saved consumer name/version suffix is not qualified for request-bound UI')
    return match.group(1)+' v'+str(int(version)+1)
