"""SDK-free assembly validation and numerical data operations."""
import math as _assembly_domain_math

def _assembly_name(name: object) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be nonempty text')
    return name

def _assembly_nested_options(data: "JsonObject") -> None:
    if 'placementSpace' in data and data['placementSpace'] not in ('root', 'parent'):
        raise ValueError('placementSpace must be root or parent')
    if 'sharedParentPolicy' in data and data['sharedParentPolicy'] != 'allInstances':
        raise ValueError('sharedParentPolicy must be allInstances')

def _assembly_pose_delta(before: list[int | float],
                         after: list[int | float]) -> tuple[float, float]:
    linear = _assembly_domain_math.sqrt(sum((before[i] - after[i]) ** 2 for i in (3, 7, 11)))
    trace = sum(before[4 * row + column] * after[4 * row + column]
                for row in range(3) for column in range(3))
    cosine = max(-1.0, min(1.0, (trace - 1.0) / 2.0))
    return linear, _assembly_domain_math.acos(cosine)
