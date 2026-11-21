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


def measure_baseline_capture(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _brep_baseline_execute('capture', ctx, data, data.get('_trustedBinding'))


def measure_baseline_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return {'status': 'unsupported', 'passed': False, 'precision': 'exact',
            'reason': 'Owned artifact inspection is provided by the trusted Node service'}


def measure_baseline_compare(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _brep_baseline_execute('compare', ctx, data, data.get('_trustedBinding'))


def measure_baseline_capture_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _brep_baseline_execute('capture', ctx, data, data.get('_trustedBinding'))


def measure_baseline_compare_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _brep_baseline_execute('compare', ctx, data, data.get('_trustedBinding'))


CAD_HANDLERS.update({
    'measure.baseline.capture': measure_baseline_capture,
    'measure.baseline.inspect': measure_baseline_inspect,
    'measure.baseline.compare': measure_baseline_compare,
})
CAD_HANDLERS.update({
    'measure.baseline.capture_internal': measure_baseline_capture_internal,
    'measure.baseline.compare_internal': measure_baseline_compare_internal,
})

_FMCAD_BREP_BASELINE_LOADED = True
