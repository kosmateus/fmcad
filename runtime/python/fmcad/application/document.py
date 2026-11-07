"""One explicit cloud-copy attempt; no automatic lifecycle, retry or rollback.

The composition manifest initializes document_copy_request/result before this
unit. The port supplies only DTOs and effects, never native document handles.
"""


def document_copy(data: "JsonObject", port: object, warning: str) -> "JsonRecord":
    request = document_copy_request(data)
    target = _cad_cast("Callable[[JsonRecord], JsonRecord]", getattr(port, 'target'))(request)
    original = _cad_cast("Callable[[], JsonRecord]", getattr(port, 'snapshot'))()
    original_error = original.get('dataFileError')
    if original_error:
        error = _cad_cast("JsonObject", original_error)
        raise RuntimeError(_cad_cast(str, error['message']))
    _cad_cast("Callable[[JsonRecord, str], None]", getattr(port, 'progress'))(target, warning)
    # Entry errors propagate unchanged. Never turn an uncertain save into failure
    # followed by an implicit second attempt.
    accepted = _cad_cast("Callable[[JsonRecord], object]", getattr(port, 'save_copy'))(request)
    readback_error: "JsonValue | None" = None
    try:
        current: JsonRecord | None = _cad_cast("Callable[[], JsonRecord]", getattr(port, 'snapshot'))()
        current_error = current.get('dataFileError')
        if current_error:
            readback_error = current_error
            current = None
    except Exception as exc:
        current = None
        readback_error = {'type': type(exc).__name__, 'message': str(exc)}
    return document_copy_result(accepted, original, current, target, warning, readback_error)
