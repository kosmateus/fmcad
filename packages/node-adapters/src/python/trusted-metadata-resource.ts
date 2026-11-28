/**
 * Compiler-owned SDK reader, never caller source. It requires ROOT's qualified
 * clean host, current invocation ambient and native receipt provenance. Neither
 * the reader nor a digest of its output grants SDK or Python execution authority.
 *
 * Imports under TYPE_CHECKING do not import SDK modules during execution. The
 * actual app is supplied only to this trusted unit, not to user facade globals.
 */
export const trustedMetadataResource = String.raw`
from typing import TYPE_CHECKING, cast
if TYPE_CHECKING:
    import adsk.core
    from typing import TypedDict

    class _MetadataBinding(TypedDict):
        requestId: str
        requestSha256: str
        sourceSha256: str
        nativeSessionId: str
        hostGeneration: str
        resourceHash: str
        wireHash: str

    class _MetadataFile(TypedDict):
        id: str

    class _MetadataDocument(TypedDict):
        creationId: str
        name: str
        isSaved: bool
        isModified: bool
        dataFile: _MetadataFile | None

    class _MetadataSnapshot(TypedDict):
        schema: str
        binding: _MetadataBinding
        documents: list[_MetadataDocument]
        activeDocument: _MetadataDocument | None

app: "adsk.core.Application"
_fmcad_metadata_host_binding: "dict[str, str]"

def _fmcad_metadata_text(value: str, identity: bool = False) -> str:
    if type(value) is not str or len(value) > 8192 or (identity and not value):
        raise ValueError("Unsupported metadata text")
    return value

def _fmcad_metadata_row(doc: "adsk.core.Document") -> "_MetadataDocument":
    creation_id = _fmcad_metadata_text(doc.creationId, True)
    name = _fmcad_metadata_text(doc.name)
    saved = doc.isSaved
    modified = doc.isModified
    if type(saved) is not bool or type(modified) is not bool:
        raise ValueError("Unsupported metadata flags")
    # The established document-status reader does not query dataFile on an
    # unsaved document. A saved getter failure propagates; never fabricate null.
    data_file = doc.dataFile if saved else None
    file_row: "_MetadataFile | None" = None
    if data_file is not None:
        file_row = {"id": _fmcad_metadata_text(data_file.id, True)}
    if doc.creationId != creation_id:
        raise ValueError("Document identity changed during metadata read")
    return {"creationId": creation_id, "name": name, "isSaved": saved,
            "isModified": modified, "dataFile": file_row}

def _fmcad_collect_metadata(
    application: "adsk.core.Application",
    observed: "dict[str, str]",
    expected: "dict[str, str]",
) -> "_MetadataSnapshot":
    # observed is ROOT-owned current host context. Matching strings alone are
    # not proof of provenance. ROOT also binds the resulting envelope to its
    # original request, current native receipt and FINAL combined wire.
    if type(observed) is not dict or len(observed) != 7:
        raise ValueError("Unsupported metadata binding")
    for key in observed:
        if type(key) is not str:
            raise ValueError("Unsupported metadata binding key")
    for key, value in expected.items():
        if key not in observed or type(observed[key]) is not str or observed[key] != value:
            raise ValueError("Stale or wrong metadata invocation binding")
    wire_hash = observed["wireHash"]
    if type(wire_hash) is not str or len(wire_hash) != 64:
        raise ValueError("Unsupported final wire binding")
    for char in wire_hash:
        if char not in "0123456789abcdef":
            raise ValueError("Unsupported final wire binding")
    binding: "_MetadataBinding" = {
        "requestId": observed["requestId"], "requestSha256": observed["requestSha256"],
        "sourceSha256": observed["sourceSha256"], "nativeSessionId": observed["nativeSessionId"],
        "hostGeneration": observed["hostGeneration"], "resourceHash": observed["resourceHash"],
        "wireHash": wire_hash,
    }
    # Observe focus once. A different peer focus later is not an identity
    # failure, nor must the active observation belong to the later collection.
    # The SDK stubs declare Document, while an empty application has no active
    # document. This local nullable cast preserves the actual SDK semantics.
    active_doc = cast("adsk.core.Document | None", application.activeDocument)
    active = _fmcad_metadata_row(active_doc) if active_doc is not None else None
    documents = application.documents
    count = documents.count
    if type(count) is not int or count < 0 or count > 1024:
        raise ValueError("Unsupported document inventory size")
    rows: "list[_MetadataDocument]" = []
    identities: set[str] = set()
    for index in range(count):
        doc = documents.item(index)
        row = _fmcad_metadata_row(doc)
        if row["creationId"] in identities:
            raise ValueError("Duplicate document identity")
        identities.add(row["creationId"])
        rows.append(row)
    return {"schema": "readonly-metadata-snapshot-v1", "binding": binding,
            "documents": rows, "activeDocument": active}

def _fmcad_metadata_current(expected: "dict[str, str]") -> "_MetadataSnapshot":
    return _fmcad_collect_metadata(app, _fmcad_metadata_host_binding, expected)
`;
