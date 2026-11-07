"""Public baseline handler ownership, registered in the canonical cad-v1 bundle."""
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'measure-baseline'


def _measure_baseline_handler(mode: str) -> "Callable[[CadContext, JsonObject], JsonRecord]":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
        if mode == 'inspect':
            return {'status': 'unsupported', 'passed': False, 'precision': 'exact',
                    'reason': 'Owned artifact inspection is provided by the trusted Node service'}
        return _brep_baseline_execute(mode, ctx, data, data.get('_trustedBinding'))
    return handler


def _measure_baseline_internal_handler(mode: str) -> "Callable[[CadContext, JsonObject], JsonRecord]":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
        return _brep_baseline_execute(mode, ctx, data, data.get('_trustedBinding'))
    return handler


CAD_HANDLERS.update({
    'measure.baseline.capture': _measure_baseline_handler('capture'),
    'measure.baseline.inspect': _measure_baseline_handler('inspect'),
    'measure.baseline.compare': _measure_baseline_handler('compare'),
})
CAD_HANDLERS.update({
    'measure.baseline.capture_internal': _measure_baseline_internal_handler('capture'),
    'measure.baseline.compare_internal': _measure_baseline_internal_handler('compare'),
})

_FMCAD_BREP_BASELINE_LOADED = True
