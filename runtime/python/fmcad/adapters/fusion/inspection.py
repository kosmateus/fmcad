"""Fusion inspection adapter; dispatched only inside the existing CAD SDK turn."""
from typing import TYPE_CHECKING as _INSPECTION_ADAPTER_TYPE_CHECKING

if _INSPECTION_ADAPTER_TYPE_CHECKING:
    from collections.abc import Callable as _InspectionCallable
    from collections.abc import Sequence as _InspectionSequence
    from typing import Protocol as _InspectionProtocol
    import adsk.fusion

    _InspectionEntityLoader = _InspectionCallable[
        [str | None, adsk.fusion.Component | None, adsk.fusion.Occurrence | None],
        _InspectionSequence[CadEntity],
    ]
    _InspectionCacheKey = tuple[str | None, int, int]
    _InspectionSnapshot = tuple[
        adsk.fusion.Component | None,
        adsk.fusion.Occurrence | None,
        tuple[CadEntity, ...],
    ]

    class _InspectionContext(_InspectionProtocol):
        def call(self, operation: str, data: object) -> JsonValue: ...

        def _entities(
            self,
            kind: str | None = None,
            component: adsk.fusion.Component | None = None,
            occurrence: adsk.fusion.Occurrence | None = None,
        ) -> _InspectionSequence[CadEntity]: ...


def _inspection_pack(ctx: "_InspectionContext", data: JsonObject) -> JsonObject:
    # The validated standalone CAD wrapper owns the sole trusted catalog inventory.
    request_value = _cad_cast("object", globals().get('_FMCAD_REQUEST'))
    if not isinstance(request_value, dict):
        raise ValueError('inspect.pack requires its validated standalone CAD preparation')
    request = _cad_cast("JsonObject", request_value)
    prepared_data = request.get('data')
    if request.get('operation') != 'inspect.pack' or data is not prepared_data:
        raise ValueError('inspect.pack requires its validated standalone CAD preparation')
    # One invocation-local entity inventory, never tokens/results retained across
    # SDK turns. Return copies: legacy resolution may append candidate lists.
    original = _cad_cast("_InspectionEntityLoader", object.__getattribute__(ctx, '_entities'))
    snapshots: "dict[_InspectionCacheKey, _InspectionSnapshot]" = {}
    sentinel = object()
    attributes = _cad_cast("dict[str, object]", object.__getattribute__(ctx, '__dict__'))
    previous = attributes.get('_entities', sentinel)

    def entities(
        kind: str | None = None,
        component: "adsk.fusion.Component | None" = None,
        occurrence: "adsk.fusion.Occurrence | None" = None,
    ) -> "_InspectionSequence[CadEntity]":
        key = (kind, id(component), id(occurrence))
        if key not in snapshots:
            snapshots[key] = (component, occurrence, tuple(original(kind, component, occurrence)))
        return list(snapshots[key][2])

    setattr(ctx, '_entities', entities)
    try:
        return inspection_pack(
            _cad_cast("_InspectionPlan", data),
            ctx.call,
            _cad_json,
        )
    finally:
        if previous is sentinel:
            attributes.pop('_entities', None)
        else:
            setattr(ctx, '_entities', previous)


CAD_HANDLERS['inspect.pack'] = _inspection_pack
