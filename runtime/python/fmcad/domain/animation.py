"""DTO-only rules extracted from assets/cad/animation.py. No SDK or filesystem access."""
import math as _animation_rules_math

_ANIMATION_LIMITATIONS = [
    'No exposed stable action-creation interface or video publishing in this supported SDK profile.',
    'Storyboard refs use document creationId and zero-based index, not name/id properties.',
    'Indices are not persistent after reorder, insertion or deletion; relist before use.',
    'Playback returns started, not completed; no stop method is assumed.'
]

def _animation_number(value: object, label: str) -> "int | float":
    if type(value) is int:
        number = value
    elif type(value) is float:
        number = value
    else:
        raise ValueError(label + ' must be a finite number')
    if not _animation_rules_math.isfinite(number):
        raise ValueError(label + ' must be a finite number')
    return number
