import math

_MEASURE_UNITS = {
    'length': {'mm': 10.0, 'cm': 1.0, 'm': 0.01, 'in': 1 / 2.54},
    'area': {'mm2': 100.0, 'cm2': 1.0, 'm2': 0.0001},
    'volume': {'mm3': 1000.0, 'cm3': 1.0, 'm3': 0.000001},
    'mass': {'kg': 1.0, 'g': 1000.0},
    'angle': {'deg': 180 / math.pi, 'rad': 1.0},
}

def _measure_value(value: float, dimension: "Literal['length', 'area', 'volume', 'mass', 'angle']", data: "JsonObject") -> "JsonObject":
    units = _cad_cast(str, data.get('units', next(iter(_MEASURE_UNITS[dimension]))))
    if units not in _MEASURE_UNITS[dimension]:
        raise ValueError('Unsupported %s units: %s' % (dimension, units))
    value = float(value) * _MEASURE_UNITS[dimension][units]
    if not math.isfinite(value):
        raise ValueError('Measurement is non-finite')
    return {'value': value, 'units': units, 'dimension': dimension}
