import json as _helpers_json
from typing import cast as _helpers_cast


class _FMCADNotEmitted:
    __slots__ = ()


_NOT_EMITTED = _FMCADNotEmitted()


class FMCAD:
    """Trusted convenience facade; dispatch is not a Python sandbox."""
    def __init__(self, context: "CadContext", readonly: bool = False,
                 stage_context: object = None,
                 read_only_operations: list[str] | tuple[str, ...] = ()) -> None:
        self._context = context
        self._readonly = readonly
        self._emitted: "JsonValue | _FMCADNotEmitted" = _NOT_EMITTED
        if stage_context is not None and not isinstance(stage_context, dict):
            raise TypeError('authenticated stage context must be an object')
        self._stage_context: "JsonObject | None" = (
            _helpers_cast("JsonObject", stage_context) if stage_context is not None else None)
        self._read_only_operations: tuple[str, ...] = tuple(read_only_operations)
        self.calls: list[JsonRecord] = []
        self.doc = getattr(context, 'doc', None)
        self.design = getattr(context, 'design', None)
        self.root = getattr(context, 'root', None)

    def _require_stage_context(self) -> "JsonObject":
        context = self._stage_context
        if context is None:
            raise RuntimeError('stage journal is available only in an authenticated queued worker')
        return context

    def stage(self) -> "JsonValue":
        context = self._require_stage_context()
        stage = context.get('stage')
        if not isinstance(stage, dict):
            raise RuntimeError('authenticated job does not provide a current stage')
        return stage

    def journalInspect(self) -> "JsonValue":
        context = self._require_stage_context()
        inspection = context.get('inspection')
        if not isinstance(inspection, dict):
            raise RuntimeError('stage journal inspection is unavailable')
        return inspection

    def resumePlan(self) -> "JsonValue":
        context = self._require_stage_context()
        plan = context.get('resumePlan')
        if not isinstance(plan, dict):
            raise RuntimeError('stage resume plan is unavailable')
        return plan

    def call(self, operation: str, data: "JsonObject",
             component: "JsonValue" = None) -> "JsonValue":
        readonly = self._read_only_operations or getattr(self._context, 'read_only_operations', ())
        if self._readonly and operation not in readonly:
            raise RuntimeError('readonly helper dispatch rejected mutating operation')
        record: JsonRecord = {'operation': operation, 'status': 'failed', 'effects': 'unknown'}
        self.calls.append(record)
        try:
            previous = self._context.component
            try:
                if component is not None:
                    self._context.component = _helpers_cast(
                        "adsk.fusion.Component", self.resolve(component, 'component'))
                result = self._context.call(operation, data)
            finally:
                self._context.component = previous
            record.update(status='completed', effects='observed')
            return result
        except BaseException:
            raise

    def resolve(self, ref: object, expected_kind: "str | None" = None) -> "CadEntity":
        return self._context.resolve(ref, expected_kind)

    def length(self, expression: object) -> float: return self._context.length(expression)
    def angle(self, expression: object) -> float: return self._context.angle(expression)
    def point(self, coordinates: object) -> object: return self._context.point(coordinates)
    def value(self, expression: object) -> object: return self._context.value(expression)
    def collection(self, entities: "Iterable[CadEntity]") -> object: return self._context.collection(entities)

    def selection_rule_define(self, rule_id: str, query: "JsonObject",
                              exclude: "JsonValue" = None) -> "JsonValue":
        data: "JsonObject" = {'ruleId': rule_id, 'query': query}
        if exclude is not None:
            data['exclude'] = exclude
        return self.call('selection.rule.define', data)

    def selection_rule_inspect(self, manifest: "JsonObject") -> "JsonValue":
        return self.call('selection.rule.inspect', {'manifest': manifest})

    def selection_rule_resolve(self, manifest: "JsonObject") -> "JsonValue":
        return self.call('selection.rule.resolve', {'manifest': manifest})

    def selection_rule_check(self, manifest: "JsonObject") -> "JsonValue":
        return self.call('selection.rule.check', {'manifest': manifest})

    def mechanism_drive_test(self, data: "JsonObject") -> "JsonValue":
        return self.call('mechanism.drive-test', data)

    def frame_context_audit(self, data: "JsonObject") -> "JsonValue":
        return self.call('frame.context_audit', data)

    def snapshot_capture_v2(self, data: "JsonObject") -> "JsonValue":
        return self.call('snapshot.capture_v2', data)

    def snapshot_diff_v2(self, data: "JsonObject") -> "JsonValue":
        return self.call('snapshot.diff_v2', data)

    def parameter_test(self, spec: "JsonObject", check_case: "Callable[..., object] | None" = None,
                       check_restored: "Callable[..., object] | None" = None) -> "JsonValue":
        if self._readonly:
            raise RuntimeError('readonly helper dispatch rejected mutating operation')
        if not callable(check_case) or not callable(check_restored):
            raise TypeError('parameter_test requires check_case and check_restored callbacks')
        return _helpers_cast("JsonValue", _measure_parameter_test(self._context, spec, check_case, check_restored))

    def temporary_body(self, ref: "JsonValue", frame: "JsonValue") -> "_MeasureTemporaryBody":
        return _measure_temporary_body(self._context, ref, frame)

    def compare_bodies(self, a: "JsonValue", b: "JsonValue", frame: "JsonValue",
                       volume_tolerance: "JsonValue", linear_tolerance: "JsonValue",
                       angular_tolerance: "JsonValue") -> "JsonValue":
        return _helpers_cast("JsonValue", _measure_compare_bodies(
            self._context, a, b, frame, volume_tolerance, linear_tolerance, angular_tolerance))

    def require_pass(self, result: "JsonValue") -> "JsonObject":
        if not isinstance(result, dict): raise RuntimeError('result is not an object')
        result_record = result
        flags = [key for key in ('accepted', 'checkPassed', 'passed') if key in result_record]
        if not flags or any(type(result_record[key]) is not bool or not result_record[key] for key in flags):
            raise RuntimeError('result does not contain unambiguous acceptance')
        if result_record.get('success') is False or result_record.get('failed') is True:
            raise RuntimeError('result reports failure')
        if result_record.get('unsupported') is True or result_record.get('supported') is False:
            raise RuntimeError('result reports unsupported evidence')
        nonpassing = ('not_checked', 'notchecked', 'not_evaluated', 'notevaluated',
                      'unknown', 'unresolved', 'partial', 'sampled', 'unavailable',
                      'unsupported', 'missing', 'stale', 'blocked', 'error', 'fail', 'failed')
        for key in ('status', 'evidenceStatus', 'probeStatus', 'checkOutcome', 'precision', 'coverage'):
            if key not in result_record: continue
            value = result_record[key]
            if type(value) is not str or value.lower() in nonpassing:
                raise RuntimeError('result status is unresolved or failed')
            if key in ('evidenceStatus', 'probeStatus', 'checkOutcome') and value.lower() != 'pass':
                raise RuntimeError('result status is unresolved or failed')
        if 'sampledPassed' in result_record and type(result_record['sampledPassed']) is not bool:
            raise RuntimeError('sampled result status is unresolved or failed')
        if result_record.get('sampledPassed') is False:
            raise RuntimeError('sampled result reports failure')
        if result_record.get('sampledPassed') is True:
            raise RuntimeError('sampled result is partial evidence')
        if result_record.get('partial') is True or (result_record.get('restored') is False and result_record.get('leftRequestedState') is not True):
            raise RuntimeError('result reports partial or unrestored evidence')
        return result_record

    def require_history_end(self) -> None:
        design = _helpers_cast("adsk.fusion.Design", self.design)
        timeline = _helpers_cast("adsk.fusion.Timeline", getattr(design, 'timeline'))
        if timeline.markerPosition != timeline.count:
            raise RuntimeError('history marker is not at end')

    def emit(self, payload: "JsonValue") -> None:
        if self._emitted is not _NOT_EMITTED: raise RuntimeError('FMCAD.emit may be called once')
        _helpers_json.dumps(payload, allow_nan=False)
        self._emitted = payload

    @property
    def has_emitted(self) -> bool:
        return self._emitted is not _NOT_EMITTED

    def terminal(self, error: "object | None" = None) -> None:
        result: JsonRecord = {'success': error is None,
                              'helperCallsOnly': self.calls}
        if self._emitted is not _NOT_EMITTED:
            result['result'] = _helpers_cast("JsonValue", self._emitted)
        if error is not None: result['error'] = str(error)
        try: print('FMCAD_RESULT ' + _helpers_json.dumps(result, allow_nan=False))
        except Exception: pass

    def _terminal(self, error: "object | None" = None) -> None:
        self.terminal(error)
