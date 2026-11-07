"""Fusion port over retained measure helpers; no mesh fallback or document import."""
import math as _brep_fusion_math
import os as _brep_fusion_os
import time as _brep_fusion_time
from collections.abc import Callable as _BrepCallable, Sequence as _BrepSequence
from typing import ContextManager as _BrepContextManager
from typing import TYPE_CHECKING as _BREP_FUSION_TYPE_CHECKING, Protocol as _BrepFusionProtocol
from typing import cast as _brep_fusion_cast


if _BREP_FUSION_TYPE_CHECKING:
    class _BrepArtifactsPort(_BrepFusionProtocol):
        def publish(self, manifest: "_BrepManifest",
                    snapshots: "_BrepSequence[_BrepSnapshot]") -> "JsonRecord": ...

        def restore(self, reference: "JsonObject") -> "tuple[_BrepManifest, list[_BrepSnapshot]]": ...

    class _BrepTemporaryBRepManager(_BrepFusionProtocol):
        def exportToFile(self, bodies: "_BrepSequence[adsk.fusion.BRepBody]", path: str) -> bool: ...

        def createFromFile(self, path: str) -> "_BrepSequence[adsk.fusion.BRepBody] | None": ...

    class _BrepStageHost(_BrepFusionProtocol):
        paths: list[str]

        def stage(self) -> _BrepContextManager[str]: ...

        def read_stage(self, path: str) -> bytes: ...

        def read(self, reference: "JsonObject") -> "JsonRecord": ...

    class _BrepEntityAssemblyContext(_BrepFusionProtocol):
        assemblyContext: "adsk.fusion.Occurrence | None"

    class _BrepDataFile(_BrepFusionProtocol):
        id: str
        versionNumber: int | None


class FusionBrepBaselinePort:
    def __init__(self, ctx: "CadContext", helpers: "dict[str, object]",
                 source: "_BrepCallable[[], JsonRecord]",
                 identity: "_BrepCallable[[JsonValue], JsonRecord]",
                 budget: "_BrepCallable[[], None]",
                 artifacts: "_BrepArtifactsPort | None" = None) -> None:
        self.ctx, self.helpers = ctx, helpers
        self._source_reader = source
        self._identity_reader = identity
        self._budget_check = budget
        self.artifacts = artifacts

    def source(self) -> "JsonRecord":
        return self._source_reader()

    def identity(self, ref: "JsonValue") -> "JsonRecord":
        return self._identity_reader(ref)

    def budget(self) -> None:
        self._budget_check()

    def snapshot(self, ref: "JsonValue", frame: "JsonValue") -> "_BrepSnapshot":
        temporary_body = _brep_fusion_cast(
            "_BrepCallable[[CadContext, JsonValue, JsonValue], _MeasureTemporaryBody]",
            self.helpers['_measure_temporary_body'])
        return temporary_body(self.ctx, ref, frame)

    def compare(self, snapshot: "_BrepSnapshot", ref: "JsonValue", frame: "JsonValue",
                tolerances: "JsonObject") -> "JsonRecord":
        # Validate dimensional numeric values too: the retained helper rejects
        # negative values but legacy SDK doubles may return NaN/Infinity.
        expression = _brep_fusion_cast(
            "_BrepCallable[[object, str | None], tuple[str, float]]",
            getattr(self.ctx, '_expression'))
        for key, units in (('volume', 'cm^3'), ('length', 'cm'), ('angle', 'rad')):
            value = expression(tolerances[key], units)[1]
            if not _brep_fusion_math.isfinite(value) or value < 0:
                raise ValueError('Tolerance must be finite and nonnegative')
        volume_tolerance = _brep_fusion_cast('str', tolerances['volume'])
        linear_tolerance = _brep_fusion_cast('str', tolerances['length'])
        angular_tolerance = _brep_fusion_cast('str', tolerances['angle'])
        compare = _brep_fusion_cast(
            "_BrepCallable[[CadContext, _MeasureTemporaryBody | JsonValue, JsonValue, JsonValue, str, str, str], JsonRecord]",
            self.helpers['_measure_compare_bodies'])
        result = compare(self.ctx, _brep_fusion_cast('_MeasureTemporaryBody', snapshot), ref, frame,
                         volume_tolerance, linear_tolerance, angular_tolerance)
        self.budget()
        return result

    def publish(self, manifest: "_BrepManifest",
                snapshots: "_BrepSequence[_BrepSnapshot]") -> "JsonRecord":
        if self.artifacts is None:
            return {'status': 'unsupported', 'passed': False, 'precision': 'exact',
                    'reason': 'Owned exact artifact port is not installed'}
        return self.artifacts.publish(manifest, snapshots)

    def restore(self, reference: "JsonObject") -> "tuple[_BrepManifest, list[_BrepSnapshot]]":
        if self.artifacts is None:
            raise RuntimeError('Owned exact artifact port is not installed')
        return self.artifacts.restore(reference)


class FusionExactBrepSerializer:
    """Trusted staging paths only; caller owns bounded reads and durable publication.

    TemporaryBRepManager exportToFile/createFromFile operates on temporary
    bodies, not on the user's document. A callable API probe is not native
    roundtrip qualification.
    """
    format = 'fusion-temporary-brep-smt-v1'

    def __init__(self, manager: "_BrepTemporaryBRepManager") -> None:
        self.manager = manager

    def supported(self) -> bool:
        return hasattr(self.manager, 'exportToFile') and hasattr(self.manager, 'createFromFile')

    def export(self, snapshots: "_BrepSequence[_BrepSnapshot]", trusted_path: str) -> None:
        if not self.supported():
            raise NotImplementedError('Exact temporary BRep serializer unavailable; mesh fallback forbidden')
        if not trusted_path.endswith('.smt'):
            raise ValueError('Exact serializer requires owned .smt staging path')
        if self.manager.exportToFile([item.body for item in snapshots], trusted_path) is not True:
            raise RuntimeError('Exact BRep export failed')

    def restore(self, manifest: "_BrepManifest", trusted_path: str,
                wrap: "_BrepCallable[[adsk.fusion.BRepBody, JsonObject | str, list[int | float]], _MeasureTemporaryBody]") -> "list[_BrepSnapshot]":
        if not self.supported():
            raise NotImplementedError('Exact temporary BRep serializer unavailable')
        if not trusted_path.endswith('.smt'):
            raise ValueError('Exact serializer requires owned .smt staging path')
        bodies = self.manager.createFromFile(trusted_path)
        if bodies is None or len(bodies) != len(manifest['bodies']):
            raise RuntimeError('Exact BRep import count mismatch')
        result: list[_BrepSnapshot] = []
        for body, row in zip(bodies, manifest['bodies']):
            if not body.isSolid or not body.isValid:
                raise RuntimeError('Exact BRep import returned invalid/non-solid body')
            result.append(wrap(body, manifest['frame'], list(row['pose'])))
        return result


class FusionBrepBaselineArtifacts:
    """Bridge exact SDK staging to the shared owned-artifact host port.

    host.stage() is a context manager yielding an owned .smt path. host.read_stage
    and write_stage enforce byte limits and containment; host.publish/read use
    the TS BrepBaselineArtifacts contract. Paths never come from request JSON.
    One file per body avoids relying on multi-body import ordering.
    """
    def __init__(self, serializer: FusionExactBrepSerializer, host: "_BrepStageHost",
                 wrap: "_BrepCallable[[adsk.fusion.BRepBody, JsonObject | str, list[int | float]], _MeasureTemporaryBody]",
                 budget: "_BrepCallable[[], None]") -> None:
        self.serializer, self.host = serializer, host
        self.wrap, self.budget = wrap, budget

    def publish(self, manifest: "_BrepManifest",
                snapshots: "_BrepSequence[_BrepSnapshot]") -> "JsonRecord":
        if not self.serializer.supported():
            raise NotImplementedError('Exact temporary BRep serializer unavailable; mesh fallback forbidden')
        payloads: list[bytes] = []
        for snapshot in snapshots:
            self.budget()
            with self.host.stage() as path:
                self.serializer.export([snapshot], path)
                payloads.append(self.host.read_stage(path))
        return _brep_fusion_cast('JsonRecord', {
            'status': 'pass', 'precision': 'exact', 'manifest': manifest,
            'stagedPayloadCount': len(payloads)})

    def restore(self, reference: "JsonObject") -> "tuple[_BrepManifest, list[_BrepSnapshot]]":
        if not self.serializer.supported():
            raise NotImplementedError('Exact temporary BRep serializer unavailable')
        record = self.host.read(reference)
        manifest = _brep_fusion_cast('_BrepManifest', record['manifest'])
        payloads = _brep_fusion_cast('list[bytes]', record['exactBodies'])
        if len(payloads) != len(manifest['bodies']):
            raise RuntimeError('Exact payload count mismatch')
        snapshots: list[_BrepSnapshot] = []
        for row, payload, path in zip(manifest['bodies'], payloads, self.host.paths):
            self.budget()
            if not payload:
                raise RuntimeError('Exact BRep payload is empty')
            single = _brep_fusion_cast('_BrepManifest', dict(manifest, bodies=[row]))
            snapshots.extend(self.serializer.restore(single, path, self.wrap))
        return manifest, snapshots


class _BrepBaselineStageHost:
    """File-only trusted bridge; Node owns the directory and final publication."""
    def __init__(self, binding: "JsonObject") -> None:
        paths_value = binding.get('stagePaths')
        if not isinstance(paths_value, list) or any(not isinstance(path, str) for path in paths_value):
            raise ValueError('Trusted BRep staging requires unique per-body paths')
        self.paths = _brep_fusion_cast('list[str]', paths_value)
        self.manifest: "JsonValue" = binding.get('manifest')
        self.byte_limit = _brep_fusion_cast('int', binding['maxBytes'])
        if not self.paths or len(set(self.paths)) != len(self.paths):
            raise ValueError('Trusted BRep staging requires unique per-body paths')
        if any(not _brep_fusion_os.path.isabs(path) or not path.endswith('.smt') for path in self.paths):
            raise ValueError('Trusted BRep staging path must be absolute owned .smt')
        if len(self.paths) > 1000 or len({_brep_fusion_os.path.dirname(path) for path in self.paths}) != 1 or any(
                _brep_fusion_os.path.basename(path) != '%d.smt' % index for index, path in enumerate(self.paths)):
            raise ValueError('Trusted BRep staging paths must be ordered files in one owned directory')
        self._cursor = 0

    class _Stage:
        def __init__(self, path: str) -> None: self.path = path
        def __enter__(self) -> str: return self.path
        def __exit__(self, _type: object, _value: object, _traceback: object) -> bool: return False

    def stage(self) -> "_Stage":
        if self._cursor >= len(self.paths):
            raise ValueError('Trusted BRep staging path budget exhausted')
        path = self.paths[self._cursor]
        self._cursor += 1
        if _brep_fusion_os.path.lexists(path):
            raise ValueError('Exact BRep staging target already exists')
        return self._Stage(path)

    def read_stage(self, path: str) -> bytes:
        if path not in self.paths or _brep_fusion_os.path.islink(path) or not _brep_fusion_os.path.isfile(path):
            raise ValueError('Exact BRep staging result is not an owned regular file')
        size = _brep_fusion_os.path.getsize(path)
        if not 0 < size <= self.byte_limit:
            raise ValueError('Exact BRep staging payload exceeds supported size')
        with open(path, 'rb') as stream:
            payload = stream.read(self.byte_limit + 1)
        if len(payload) != size or len(payload) > self.byte_limit:
            raise ValueError('Exact BRep staging payload changed while reading')
        return payload

    def write_stage(self, path: str, payload: bytes) -> None:
        if path not in self.paths or _brep_fusion_os.path.islink(path):
            raise ValueError('Exact BRep staging target is not owned')
        with open(path, 'xb') as stream:
            stream.write(payload)

    def publish(self, _manifest: "_BrepManifest", exact_bodies: "list[bytes]") -> "JsonRecord":
        if len(exact_bodies) != len(self.paths):
            raise ValueError('Exact BRep payload count does not match staging paths')
        return _brep_fusion_cast('JsonRecord', {
            'status': 'pass', 'precision': 'exact', 'manifest': _manifest,
            'stagedPayloadCount': len(exact_bodies)})

    def read(self, _reference: "JsonObject") -> "JsonRecord":
        if not isinstance(self.manifest, dict):
            raise ValueError('Trusted exact baseline manifest/body count mismatch')
        manifest = _brep_fusion_cast('_BrepManifest', self.manifest)
        if len(self.paths) != len(manifest['bodies']):
            raise ValueError('Trusted exact baseline manifest/body count mismatch')
        return _brep_fusion_cast('JsonRecord', {
            'manifest': manifest,
            'exactBodies': [self.read_stage(path) for path in self.paths]})


def _brep_baseline_execute(mode: str, ctx: "CadContext", data: "JsonObject",
                           binding: "JsonValue") -> "JsonRecord":
    """Execute a public action only through the trusted broker binding.

    The binding is injected by the trusted Node coordinator for its private
    native turn. It contains only its staging paths and verified manifest; the
    Node host still owns all durable publication and checksum authorization.
    """
    if binding is None:
        return {'status': 'unsupported', 'passed': False, 'precision': 'exact',
                'reason': 'Trusted broker artifact/staging binder is not installed'}
    required = {'version', 'session', 'stagePaths', 'maxBytes', 'workBudgetMs'}
    allowed = required | {'manifest'}
    if not isinstance(binding, dict) or not required.issubset(binding) or set(binding) - allowed or binding['version'] != 1:
        raise ValueError('Invalid trusted BRep baseline binder contract')
    session_value = binding.get('session')
    max_bytes_value = binding.get('maxBytes')
    work_budget_value = binding.get('workBudgetMs')
    if (not isinstance(session_value, str) or
            type(max_bytes_value) is not int or max_bytes_value <= 0 or
            type(work_budget_value) is not int or work_budget_value <= 0):
        raise ValueError('Invalid trusted BRep baseline resource bounds')
    file_value: object = ctx.doc.dataFile
    file = _brep_fusion_cast('_BrepDataFile | None', file_value)
    if file is None or not file.id or file.versionNumber is None:
        return _brep_fusion_cast('JsonRecord', {
            'status': 'unsupported', 'passed': False, 'precision': 'exact',
            'reason': 'Durable BRep baselines require a saved, versioned DataFile'})
    source_identity: "JsonRecord" = {'document': str(file.id), 'version': str(file.versionNumber)}

    def source() -> "JsonRecord":
        actual_value: object = ctx.doc.dataFile
        actual = _brep_fusion_cast('_BrepDataFile | None', actual_value)
        if actual is None or str(actual.id) != source_identity['document']:
            raise RuntimeError('Pinned DataFile identity changed')
        return {'document': str(actual.id), 'version': str(actual.versionNumber)}

    def identity(ref: "JsonValue") -> "JsonRecord":
        entity = ctx.resolve(ref, 'body')
        if not entity.isSolid or getattr(entity, 'isValid', True) is False:
            raise LookupError('Baseline reference must resolve to a valid solid body')
        occurrence = _brep_fusion_cast(
            '_BrepEntityAssemblyContext', entity).assemblyContext
        owner = _cad_owner(entity)
        if occurrence is not None:
            if occurrence not in _cad_items(ctx.root.allOccurrences):
                raise ValueError('Baseline occurrence must be root-context; supply its full path')
            instance = 'occurrence:' + occurrence.fullPathName
        else:
            owner_ref = ctx.ref(owner) if owner is not None else {'name': 'root'}
            instance = 'native:' + str(owner_ref.get('token') or owner_ref.get('name'))
        body_ref = ctx.ref(entity)
        body_id = body_ref.get('token')
        if not body_id:
            raise LookupError('Stable BRep body token is unavailable')
        return {'body': str(body_id), 'instance': instance}

    deadline = _brep_fusion_time.monotonic() + work_budget_value / 1000.0

    def budget() -> None:
        if _brep_fusion_time.monotonic() >= deadline:
            raise TimeoutError('BRep baseline work budget exhausted; no automatic retry')

    host = _BrepBaselineStageHost(binding)
    manager = _brep_fusion_cast(
        '_BrepTemporaryBRepManager', adsk.fusion.TemporaryBRepManager.get())
    serializer = FusionExactBrepSerializer(manager)
    if not serializer.supported():
        return _brep_fusion_cast('JsonRecord', {
            'status': 'unsupported', 'passed': False, 'precision': 'exact',
            'reason': 'This Fusion SDK exposes no supported exact temporary BRep serializer; mesh fallback is forbidden'})

    def wrap(body: "adsk.fusion.BRepBody", frame: "JsonObject | str",
             pose: "list[int | float]") -> "_MeasureTemporaryBody":
        return _MeasureTemporaryBody(body, frame, pose)

    artifacts = FusionBrepBaselineArtifacts(
        serializer, _brep_fusion_cast('_BrepStageHost', host), wrap, budget)
    port = FusionBrepBaselinePort(ctx, globals(), source, identity, budget, artifacts)
    service = BrepBaselineService(port, _brep_fusion_cast('str', binding['session']))
    if mode == 'capture':
        if data.get('scope') != 'durable':
            raise ValueError('Only explicit durable baseline capture is public')
        return service.capture(data['bodies'], data['frame'], 'durable')
    if mode == 'inspect':
        return service.inspect(_brep_fusion_cast('JsonObject', data['baseline']))
    return service.compare(_brep_fusion_cast('JsonObject', data['baseline']),
                           data['bodies'], data['tolerances'])
