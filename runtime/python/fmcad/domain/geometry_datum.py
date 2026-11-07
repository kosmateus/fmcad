"""Geometry datum: domain; retained cad-v1 shared namespace."""
import math as _geometry_datum_math
from typing import cast as _geometry_datum_cast


def _datum_version(data: "JsonObject") -> None:
    if 'schemaVersion' in data and (type(data['schemaVersion']) is not int or data['schemaVersion'] != 1):
        raise ValueError('GM04 schemaVersion must be 1')


def _datum_vector(value: object) -> list[int | float]:
    if not isinstance(value, (list, tuple)):
        raise ValueError('Vector requires three finite unitless numbers')
    candidates = _geometry_datum_cast('list[object] | tuple[object, ...]', value)
    if len(candidates) != 3 or any(type(v) not in (int, float) for v in candidates):
        raise ValueError('Vector requires three finite unitless numbers')
    numbers = _geometry_datum_cast('list[int | float] | tuple[int | float, ...]', candidates)
    if any(not _geometry_datum_math.isfinite(v) for v in numbers):
        raise ValueError('Vector requires three finite unitless numbers')
    return list(numbers)
