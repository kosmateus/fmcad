"""JSON-only values and validation. No host SDK or application state."""
import enum as _value_enum
import math as _value_math
from collections.abc import Callable, Generator, Iterable, Mapping, Sequence
from typing import Literal, Protocol as _Protocol, TYPE_CHECKING as _TYPE_CHECKING, TypeAlias, TypeVar, cast


JsonValue: TypeAlias = None | bool | int | float | str | Sequence["JsonValue"] | Mapping[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
JsonRecord: TypeAlias = dict[str, JsonValue]
CadHandler: TypeAlias = Callable[["CadContext", JsonObject], JsonValue]
_CadItem = TypeVar("_CadItem")
_CadItemCo = TypeVar("_CadItemCo", covariant=True)


class _HandlerMapping(_Protocol):
    def keys(self) -> Iterable[str]: ...

    def __getitem__(self, key: str, /) -> CadHandler: ...


class _CadItemCollection(_Protocol[_CadItemCo]):
    @property
    def count(self) -> int: ...

    def item(self, index: int, /) -> _CadItemCo: ...


class _CadStyle(_Protocol):
    @property
    def id(self) -> str: ...

    @property
    def name(self) -> str: ...


_CadStyleItem = TypeVar("_CadStyleItem", bound=_CadStyle)


class _CadNamed(_Protocol):
    @property
    def name(self) -> str: ...


if _TYPE_CHECKING:
    import adsk.core
    import adsk.fusion

    class _CadAttributes(_Protocol):
        def itemByName(self, groupName: str, name: str, /) -> adsk.core.Attribute | None: ...

    class _DesignCaster(_Protocol):
        @staticmethod
        def cast(arg: object) -> adsk.fusion.Design | None: ...


def json_value(value: object) -> JsonValue:
    """Project a DTO, rejecting opaque objects instead of stringifying handles."""
    if isinstance(value, _value_enum.Enum):
        return {'name': value.name, 'value': json_value(cast(object, value.value))}
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not _value_math.isfinite(value):
            raise ValueError('Non-finite value cannot be serialized')
        return value
    if isinstance(value, (list, tuple)):
        items = cast(list[object] | tuple[object, ...], value)
        return [json_value(item) for item in items]
    if isinstance(value, dict):
        items = cast(dict[object, object], value)
        if any(not isinstance(key, str) for key in items):
            raise TypeError('DTO keys must be strings')
        return {cast(str, key): json_value(item) for key, item in items.items()}
    raise TypeError('DTO cannot contain an opaque object')


def fields(data: object, required: tuple[str, ...]=(), optional: tuple[str, ...]=()) -> None:
    if not isinstance(data, dict):
        raise TypeError('Operation data must be an object')
    data = cast(dict[str, object], data)
    missing = set(required) - data.keys()
    unknown = data.keys() - set(required) - set(optional)
    if missing or unknown:
        raise ValueError('Missing inputs: %s; unsupported inputs: %s' % (sorted(missing), sorted(unknown)))
    for key in ('confirm', 'overwrite', 'unique', 'replace', 'includeModel'):
        if key in data and type(data[key]) is not bool:
            raise ValueError(key + ' must be boolean')


def direction(value: object) -> list[float]:
    if not isinstance(value, (list, tuple)):
        raise ValueError('Direction must be three finite unitless numbers')
    candidates = cast(list[object] | tuple[object, ...], value)
    if len(candidates) != 3 or any(
            isinstance(x, bool) or not isinstance(x, (int, float)) or not _value_math.isfinite(x) for x in candidates):
        raise ValueError('Direction must be three finite unitless numbers')
    coordinates = cast(list[int | float] | tuple[int | float, ...], candidates)
    norm = _value_math.hypot(*coordinates)
    if norm == 0 or not _value_math.isfinite(norm):
        raise ValueError('Direction cannot be zero or have non-finite magnitude')
    return [x / norm for x in coordinates]


class HandlerRegistry(dict[str, CadHandler]):
    """Explicit ownership transfers are supplied by the bundle manifest."""
    def __init__(self, replacements: Iterable[tuple[str, str, str]]=()) -> None:
        super().__init__()
        self.owner: str | None = None
        self.owners: dict[str, str | None] = {}
        self.replacements: set[tuple[str, str, str]] = set(
            cast(tuple[str, str, str], tuple(item)) for item in replacements)

    def __setitem__(self, key: str, value: CadHandler) -> None:
        if not callable(value):
            raise TypeError('CAD handler must be callable: ' + key)
        if key in self and (self.owners.get(key), self.owner, key) not in self.replacements:
            raise ValueError('Duplicate CAD handler: ' + key)
        super().__setitem__(key, value)
        self.owners[key] = self.owner

    def update(self, values: _HandlerMapping | Iterable[tuple[str, CadHandler]]=(), **kwargs: CadHandler) -> None:
        values = dict(values, **kwargs)
        # Validate the whole update before changing registry state.
        for key, value in values.items():
            if not callable(value):
                raise TypeError('CAD handler must be callable: ' + key)
            if key in self and (self.owners.get(key), self.owner, key) not in self.replacements:
                raise ValueError('Duplicate CAD handler: ' + key)
        for key, value in values.items():
            self[key] = value

    def dispatch(self, context: 'CadContext', operation: str, data: object) -> JsonValue:
        if operation not in self:
            raise ValueError('Unsupported CAD operation: ' + str(operation))
        if not isinstance(data, dict):
            raise TypeError('Operation data must be an object')
        return self[operation](context, cast(JsonObject, data))
