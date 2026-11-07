"""Exact many-body baseline orchestration; no SDK handles escape this port."""
import copy as _brep_baseline_copy
import math as _brep_baseline_math
from typing import TYPE_CHECKING as _BREP_TYPE_CHECKING, Literal as _BrepLiteral
from typing import Protocol as _BrepProtocol, TypedDict as _BrepTypedDict, cast as _brep_cast


if _BREP_TYPE_CHECKING:
    class _BrepBodySpec(_BrepTypedDict):
        role: str
        body: str
        instance: str
        pose: list[int | float]

    class _BrepSpec(_BrepTypedDict):
        role: str
        body: "JsonValue"

    class _BrepSource(_BrepTypedDict):
        document: str
        version: str

    class _BrepManifest(_BrepTypedDict):
        version: _BrepLiteral[1]
        scope: _BrepLiteral['session', 'durable']
        source: _BrepSource
        frame: "JsonObject | str"
        bodies: list[_BrepBodySpec]

    class _BrepSnapshot(_BrepProtocol):
        body: "adsk.fusion.BRepBody"
        frame: "JsonObject | str"

        @property
        def transform(self) -> list[int | float]: ...

    class _BrepBaselinePort(_BrepProtocol):
        def source(self) -> "JsonObject": ...

        def snapshot(self, ref: "JsonValue", frame: "JsonValue") -> _BrepSnapshot: ...

        def identity(self, ref: "JsonValue") -> "JsonRecord": ...

        def budget(self) -> None: ...

        def publish(self, manifest: _BrepManifest,
                    snapshots: "Sequence[_BrepSnapshot]") -> "JsonRecord": ...

        def restore(self, reference: "JsonObject") -> "tuple[_BrepManifest, list[_BrepSnapshot]]": ...

        def compare(self, snapshot: _BrepSnapshot, ref: "JsonValue", frame: "JsonValue",
                    tolerances: "JsonObject") -> "JsonRecord": ...


def _brep_baseline_specs(specs: "JsonValue") -> "list[_BrepSpec]":
    if not isinstance(specs, list) or not specs:
        raise ValueError('bodies must be a nonempty list')
    specification_values = specs
    roles: set[str] = set()
    result: list[_BrepSpec] = []
    for spec_value in specification_values:
        if not isinstance(spec_value, dict) or set(spec_value) != {'role', 'body'}:
            raise ValueError('Each body requires exactly role and body')
        spec = spec_value
        if not isinstance(spec['role'], str) or not spec['role'].strip() or spec['role'] in roles:
            raise ValueError('Body roles must be nonempty and unique')
        roles.add(spec['role'])
        result.append(_brep_cast('_BrepSpec', spec))
    return result


def _brep_baseline_manifest(manifest: object) -> "_BrepManifest":
    if not isinstance(manifest, dict):
        raise ValueError('Unsupported baseline manifest version')
    manifest = _brep_cast('JsonObject', manifest)
    if type(manifest.get('version')) is not int or manifest['version'] != 1:
        raise ValueError('Unsupported baseline manifest version')
    if manifest.get('scope') not in ('session', 'durable'):
        raise ValueError('Invalid baseline scope')
    source_value = manifest.get('source')
    if not isinstance(source_value, dict) or set(source_value) != {'document', 'version'}:
        raise ValueError('Baseline requires pinned document and version')
    source = source_value
    if any(not isinstance(v, str) or not v for v in source.values()):
        raise ValueError('Baseline source identity must be nonempty')
    frame = manifest.get('frame')
    valid_frame = isinstance(frame, str) and bool(frame.strip())
    if isinstance(frame, dict):
        space = frame.get('space')
        component = frame.get('component')
        valid_frame = (set(frame) == {'space', 'component'} and isinstance(space, str) and
                       bool(space.strip()) and ((isinstance(component, str) and bool(component.strip())) or
                                                isinstance(component, dict)))
    if not valid_frame:
        raise ValueError('Baseline requires explicit frame identity')
    rows_value = manifest.get('bodies')
    if not isinstance(rows_value, list) or any(not isinstance(row, dict) for row in rows_value):
        raise ValueError('Baseline bodies must be a list of records')
    rows = _brep_cast('list[JsonObject]', rows_value)
    _brep_baseline_specs([{'role': row['role'], 'body': row['body']} for row in rows])
    for row in rows:
        if not isinstance(row.get('body'), str) or not row['body']:
            raise ValueError('Baseline requires stable body identity')
        if not isinstance(row.get('instance'), str) or not row['instance']:
            raise ValueError('Baseline requires explicit native/occurrence instance identity')
        pose = row.get('pose')
        if not isinstance(pose, list) or len(pose) != 16 or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not _brep_baseline_math.isfinite(v) for v in pose):
            raise ValueError('Invalid baseline pose')
    return _brep_cast('_BrepManifest', manifest)


class BrepBaselineService:
    """One service per SDK session. Durable artifacts are delegated, never handles.

    Port: source, snapshot, identity, compare, budget, publish, restore.
    publish/restore must perform exact serialization and integrity verification.
    """
    def __init__(self, port: "_BrepBaselinePort", session: str) -> None:
        self.port = port
        self.session = session
        self._sessions: dict[str, tuple[_BrepManifest, list[_BrepSnapshot]]] = {}
        self._next: int = 0

    def capture(self, bodies: "JsonValue", frame: "JsonValue",
                scope: "_BrepLiteral['session', 'durable']" = 'session') -> "JsonRecord":
        specs = _brep_baseline_specs(bodies)
        if scope not in ('session', 'durable'):
            raise ValueError('scope must be session or durable')
        source = self.port.source()
        snapshots: list[_BrepSnapshot] = []
        rows: list[JsonRecord] = []
        for spec in specs:
            self.port.budget()
            snapshot = self.port.snapshot(spec['body'], frame)
            identity = self.port.identity(spec['body'])
            self.port.budget()
            row: JsonRecord = dict(identity, role=spec['role'], pose=list(snapshot.transform))
            rows.append(row)
            snapshots.append(snapshot)
        manifest = _brep_baseline_manifest({'version': 1, 'scope': scope,
                                            'source': source,
                                            'frame': _brep_baseline_copy.deepcopy(frame),
                                            'bodies': rows})
        if self.port.source() != source:
            return self._result('stale', 'Document changed during capture')
        if scope == 'durable':
            try:
                return self.port.publish(manifest, snapshots)
            except NotImplementedError as error:
                return self._result('unsupported', str(error))
        self._next += 1
        key = str(self._next)
        self._sessions[key] = (_brep_baseline_copy.deepcopy(manifest), snapshots)
        return _brep_cast('JsonRecord', {'status': 'pass', 'precision': 'exact', 'baseline': {
            'scope': 'session', 'session': self.session, 'id': key},
                'manifest': _brep_baseline_copy.deepcopy(manifest)})

    @staticmethod
    def _result(status: str, reason: str, **extra: "JsonValue") -> "JsonRecord":
        return dict(status=status, passed=False, precision='exact', reason=reason, **extra)

    def _load(self, reference: "JsonObject") -> "tuple[_BrepManifest, list[_BrepSnapshot]] | None":
        if reference.get('scope') == 'session':
            if reference.get('session') != self.session:
                return None
            session_id = reference.get('id')
            if not isinstance(session_id, str):
                return None
            return self._sessions.get(session_id)
        if reference.get('scope') != 'durable':
            raise ValueError('Invalid baseline reference scope')
        return self.port.restore(reference)

    def inspect(self, reference: "JsonObject") -> "JsonRecord":
        loaded = self._load(reference)
        if loaded is None:
            return self._result('missing', 'Baseline unavailable in this session/artifact scope')
        manifest, snapshots = loaded
        _brep_baseline_manifest(manifest)
        if len(snapshots) != len(manifest['bodies']):
            raise ValueError('Baseline body count does not match manifest')
        return _brep_cast('JsonRecord', {
            'status': 'pass', 'precision': 'exact', 'manifest': _brep_baseline_copy.deepcopy(manifest)})

    def compare(self, reference: "JsonObject", bodies: "JsonValue",
                tolerances: "JsonValue") -> "JsonRecord":
        specs = _brep_baseline_specs(bodies)
        if not isinstance(tolerances, dict) or set(tolerances) != {'volume', 'length', 'angle'} or any(
                not isinstance(v, str) or not v.strip() for v in tolerances.values()):
            raise ValueError('Explicit dimensional volume, length and angle tolerances required')
        loaded = self._load(reference)
        if loaded is None:
            return self._result('missing', 'Baseline unavailable')
        manifest, snapshots = loaded
        _brep_baseline_manifest(manifest)
        if len(snapshots) != len(manifest['bodies']):
            raise ValueError('Baseline body count does not match manifest')
        if self.port.source() != manifest['source']:
            return self._result('stale', 'Pinned source document/version differs')
        current: dict[str, JsonValue] = {spec['role']: spec['body'] for spec in specs}
        if set(current) != {row['role'] for row in manifest['bodies']}:
            return self._result('missing', 'Body role coverage differs')
        rows: list[JsonRecord] = []
        for row, snapshot in zip(manifest['bodies'], snapshots):
            self.port.budget()
            ref = current[row['role']]
            try:
                identity = self.port.identity(ref)
            except LookupError:
                return self._result('missing', 'Body no longer resolves', bodies=rows)
            if identity != {k: row[k] for k in ('body', 'instance')}:
                return self._result('stale', 'Body/instance identity differs', bodies=rows)
            try:
                comparison = self.port.compare(snapshot, ref, manifest['frame'], tolerances)
            except (RuntimeError, ValueError) as error:
                return self._result('unknown', str(error), bodies=rows)
            rows.append(dict(role=row['role'], **comparison))
        if self.port.source() != manifest['source']:
            return self._result('stale', 'Document changed during comparison', bodies=rows)
        geometry = all(row['volumeEqual'] is True for row in rows)
        pose = all(row['poseEqual'] is True for row in rows)
        return {'status': 'pass' if geometry and pose else 'fail', 'passed': geometry and pose,
                'precision': 'exact', 'geometryEqual': geometry, 'poseEqual': pose,
                'bodies': rows, 'tolerances': _brep_baseline_copy.deepcopy(tolerances)}
