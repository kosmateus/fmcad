"""Document identity policy shared by CAD and trusted run script builders."""
from typing import TYPE_CHECKING as _Identity_TYPE_CHECKING, Protocol as _IdentityProtocol


if _Identity_TYPE_CHECKING:
    class _IdentityDataProject(_IdentityProtocol):
        @property
        def id(self) -> str: ...


    class _IdentityDataFolder(_IdentityProtocol):
        @property
        def id(self) -> str: ...

        @property
        def parentProject(self) -> _IdentityDataProject: ...


    class _IdentityDataFile(_IdentityProtocol):
        @property
        def id(self) -> str: ...

        @property
        def name(self) -> str: ...

        @property
        def versionNumber(self) -> int: ...

        @property
        def versionId(self) -> str: ...

        @property
        def isComplete(self) -> bool: ...

        @property
        def isReadOnly(self) -> bool: ...

        @property
        def parentFolder(self) -> _IdentityDataFolder | None: ...

        @property
        def parentProject(self) -> _IdentityDataProject: ...


    class _IdentityDocumentReferences(_IdentityProtocol):
        @property
        def count(self) -> int: ...


    class _IdentityDocument(_IdentityProtocol):
        @property
        def name(self) -> str: ...

        @property
        def creationId(self) -> str: ...

        @property
        def dataFile(self) -> _IdentityDataFile | None: ...

        @property
        def allDocumentReferences(self) -> _IdentityDocumentReferences: ...

        def activate(self) -> bool: ...


    class _IdentityDocuments(_IdentityProtocol):
        @property
        def count(self) -> int: ...

        def item(self, index: int, /) -> _IdentityDocument: ...


    class _IdentityApplication(_IdentityProtocol):
        @property
        def documents(self) -> _IdentityDocuments | list[_IdentityDocument] | tuple[_IdentityDocument, ...]: ...

        @property
        def activeDocument(self) -> _IdentityDocument | None: ...


def _document_data_file(doc: '_IdentityDocument') -> 'tuple[_IdentityDataFile | None, None] | tuple[None, dict[str, str]]':
    """Keep local document identity observable when Fusion has no temporary file.

    This is not an unsaved/cloud identity assertion. Unexpected SDK failures still
    propagate, and callers requiring a file/project pin must reject missing data.
    """
    try:
        return doc.dataFile, None
    except RuntimeError as error:
        if 'Failed to get temporary file' not in str(error):
            raise
        return None, {'type': type(error).__name__, 'message': str(error)}


def _document_target(app: '_IdentityApplication', doc_name: object, project_id: object=None) -> '_IdentityDocument':
    if not isinstance(doc_name, str) or not doc_name.strip():
        raise ValueError('doc_name must be an explicit document name')
    collection = app.documents
    documents: list['_IdentityDocument'] | tuple['_IdentityDocument', ...] = (collection if isinstance(collection, (list, tuple)) else
                 [collection.item(i) for i in range(collection.count)])
    docs: list['_IdentityDocument'] = []
    for doc in documents:
        if doc.name != doc_name:
            continue
        try:
            doc.allDocumentReferences.count
        except AttributeError:
            # Older/fake document wrappers may not expose this API. Keep the
            # existing unique-name behavior when top-level status is unknown.
            pass
        except RuntimeError as error:
            if 'non-top-level document' in str(error):
                continue
            if 'Failed to get temporary file' not in str(error):
                raise
        docs.append(doc)
    if project_id is not None:
        docs = [d for d in docs if d.dataFile and d.dataFile.parentProject.id == project_id]
    if len(docs) != 1:
        raise ValueError('Document %s: expected one match, found %d' % (doc_name, len(docs)))
    return docs[0]


def _document_assert_identity(doc: '_IdentityDocument', doc_id: object=None, doc_file_id: object=None) -> None:
    import re
    # Assertions on the unique named target, never selectors or active-doc checks.
    for label, expected in (('doc-id', doc_id), ('doc-file-id', doc_file_id)):
        if expected is None:
            continue
        if not isinstance(expected, str) or not expected or re.search(r'\s', expected) or expected.startswith('-'):
            raise ValueError(label + ' requires a nonempty identity without whitespace')
        if label == 'doc-id':
            actual = doc.creationId
        else:
            file, error = _document_data_file(doc)
            if error:
                raise ValueError('doc-file-id cannot be verified for document %s: %s' %
                                 (doc.name, error['message']))
            actual = file.id if file else None
        if actual != expected:
            raise ValueError('%s mismatch for document %s: expected %s, got %s' %
                             (label, doc.name, expected, actual))


def _document_activate_target(app: '_IdentityApplication', doc: '_IdentityDocument', doc_id: object=None, doc_file_id: object=None) -> None:
    _document_assert_identity(doc, doc_id, doc_file_id)
    if app.activeDocument != doc:
        if not doc.activate():
            raise RuntimeError('Target document activation failed')
    if app.activeDocument != doc:
        raise RuntimeError('Active document does not match resolved target')
    _document_assert_identity(doc, doc_id, doc_file_id)
