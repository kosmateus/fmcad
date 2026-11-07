"""Stateless semantic-model-state use cases, with explicit observation ports."""
from collections.abc import Callable as _SemanticCallable


def _semantic_capture(port: "_SemanticCallable[[JsonObject], list[JsonRecord]]",
                      request: "JsonObject") -> "JsonRecord":
    entities = port(request)
    snapshot: "JsonRecord" = {'schemaVersion': 2, 'status': 'partial', 'coverage': 'partial',
                              'precision': 'observational',
                              'scope': _semantic_copy.deepcopy(request['scope']),
                              'entities': _semantic_copy.deepcopy(entities),
                              'exactBRepEquivalence': False}
    _semantic_index(snapshot)
    return snapshot


def _semantic_context_audit(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    observation = _semantic_fusion_frame_observation(ctx, data)
    return _semantic_frame_audit(observation, data.get('lengthToleranceCm', 1e-7),
                               data.get('matrixTolerance', 1e-9))


def _semantic_snapshot_v2(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _semantic_capture(lambda request: _semantic_fusion_entities(ctx, request), data)


def _semantic_snapshot_diff_v2(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    ctx.assert_identity()
    before = _semantic_cast('JsonObject', data['before'])
    after = _semantic_cast('JsonObject', data['after'])
    return _semantic_diff(before, after, data.get('allowedMovedSubtrees', []),
                          data.get('tolerances'))


def _semantic_register_handlers(registry: "HandlerRegistry") -> None:
    """Explicit integration hook; composition owns when it is called."""
    if hasattr(registry, 'owner'):
        registry.owner = 'semantic-model-state'
    registry.update({'frame.context_audit': _semantic_context_audit,
                     'snapshot.capture_v2': _semantic_snapshot_v2,
                     'snapshot.diff_v2': _semantic_snapshot_diff_v2})


if 'CAD_HANDLERS' in globals():
    _semantic_register_handlers(CAD_HANDLERS)
