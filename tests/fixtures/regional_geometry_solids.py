"""Analytic disjoint orthogonal solids, NOT samples or native qualification.

Difference splits a box at its exact intersection planes into disjoint slabs.
Union removes existing intersections before appending. All tested sets use
integer/rational box coordinates with exact finite volumes; no voxel grid.
"""
import copy
import math
from types import SimpleNamespace


def intersection(a, b):
    lo = tuple(max(a[i], b[i]) for i in range(3))
    hi = tuple(min(a[i + 3], b[i + 3]) for i in range(3))
    return lo + hi if all(lo[i] < hi[i] for i in range(3)) else None


def subtract(a, b):
    overlap = intersection(a, b)
    if overlap is None:
        return [a]
    result = []
    remaining = list(a)
    for axis in range(3):
        if remaining[axis] < overlap[axis]:
            slab = list(remaining)
            slab[axis + 3] = overlap[axis]
            result.append(tuple(slab))
            remaining[axis] = overlap[axis]
        if remaining[axis + 3] > overlap[axis + 3]:
            slab = list(remaining)
            slab[axis] = overlap[axis + 3]
            result.append(tuple(slab))
            remaining[axis + 3] = overlap[axis + 3]
    return result


class Body:
    def __init__(self, boxes=(), owner=None, occurrence=None):
        self.boxes = list(boxes)
        self.parentComponent = owner
        self.assemblyContext = occurrence
        self.nativeObject = None
        self.isSolid = True
        self.isValid = True
        self.entityToken = 'entity-token-' + str(id(self))
        self.revisionId = 'revision-1'
        self.temporary = False

    @property
    def volume(self):
        return sum(math.prod(b[i + 3] - b[i] for i in range(3)) for b in self.boxes)

    @property
    def boundingBox(self):
        def point(values):
            return SimpleNamespace(**dict(zip(('x', 'y', 'z'), values)))
        return SimpleNamespace(minPoint=point([min(b[i] for b in self.boxes) for i in range(3)]),
                               maxPoint=point([max(b[i + 3] for b in self.boxes) for i in range(3)]))


class Manager:
    def __init__(self):
        self.calls = []
        self.failure = None

    def copy(self, body):
        value = copy.copy(body)
        value.boxes = body.boxes.copy()
        value.temporary = True
        return value

    def transform(self, body, matrix):
        assert body.temporary
        values = matrix.asArray()
        shift = [values[3], values[7], values[11]]
        body.boxes = [tuple(b[i] + shift[i % 3] for i in range(6)) for b in body.boxes]
        return True

    def booleanOperation(self, target, tool, operation):
        assert target.temporary and tool.temporary, 'Both operands must be private copies'
        self.calls.append(operation)
        if self.failure == 'false':
            return False
        if self.failure == 'raise':
            raise RuntimeError('injected Boolean exception')
        if self.failure == 'invalid':
            target.isValid = False
            return True
        if operation == 'intersection':
            target.boxes = [c for a in target.boxes for b in tool.boxes if (c := intersection(a, b)) is not None]
        elif operation == 'difference':
            remaining = target.boxes
            for box in tool.boxes:
                remaining = [part for a in remaining for part in subtract(a, box)]
            target.boxes = remaining
        elif operation == 'union':
            existing = target.boxes.copy()
            for box in tool.boxes:
                remaining = [box]
                for a in existing:
                    remaining = [part for b in remaining for part in subtract(b, a)]
                existing.extend(remaining)
            target.boxes = existing
        else:
            raise AssertionError(operation)
        return True
