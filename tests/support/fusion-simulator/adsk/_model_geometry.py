"""Explicit rectangular-prism model for historical box and rollback assertions."""
from __future__ import annotations

from collections.abc import Iterator
import hashlib
import json
import uuid
from typing import TYPE_CHECKING, ClassVar

from . import core
if TYPE_CHECKING:
    from . import fusion


class FeatureOperations:
    NewBodyFeatureOperation: ClassVar[int] = 3


class ExtentDirections:
    PositiveExtentDirection: ClassVar[int] = 0
    NegativeExtentDirection: ClassVar[int] = 1


class SketchPoint(core.Base):
    def __init__(self, geometry: core.Point3D) -> None:
        self.geometry: core.Point3D = geometry


class SketchLine(core.Base):
    def __init__(self, start: core.Point3D, end: core.Point3D) -> None:
        self.startSketchPoint: SketchPoint = SketchPoint(start)
        self.endSketchPoint: SketchPoint = SketchPoint(end)


class SketchLineList(core.Collection[SketchLine]):
    pass


class Profile(core.Base):
    def __init__(self, sketch: Sketch, first: core.Point3D, second: core.Point3D) -> None:
        self.model_sketch: Sketch = sketch
        self.model_first: core.Point3D = first
        self.model_second: core.Point3D = second


class Profiles(core.Collection[Profile]):
    pass


class SketchLines(core.Collection[SketchLine]):
    def __init__(self, sketch: Sketch) -> None:
        super().__init__()
        self.model_sketch: Sketch = sketch

    def addTwoPointRectangle(self, pointOne: core.Base, pointTwo: core.Base) -> SketchLineList:
        timeline = self.model_sketch.parentComponent.model_design.timeline
        if timeline.markerPosition != timeline.count:
            raise NotImplementedError("Editing a rolled-back timeline is not modeled")
        if not isinstance(pointOne, core.Point3D) or not isinstance(pointTwo, core.Point3D):
            raise NotImplementedError("Only literal rectangle points are modeled")
        if self.model_sketch.profiles.count:
            raise NotImplementedError("Multiple loops and overlap solving are not modeled")
        if pointOne.z != 0 or pointTwo.z != 0:
            raise ValueError("Rectangle points must lie in the sketch plane")
        if pointOne.x == pointTwo.x or pointOne.y == pointTwo.y:
            raise ValueError("Degenerate rectangle")
        points = [pointOne, core.Point3D(pointTwo.x, pointOne.y, 0),
                  pointTwo, core.Point3D(pointOne.x, pointTwo.y, 0)]
        lines = [SketchLine(points[i], points[(i+1) % 4]) for i in range(4)]
        self.values.extend(lines)
        self.model_sketch.profiles.values.append(Profile(self.model_sketch, pointOne, pointTwo))
        self.model_sketch.parentComponent.model_design.model_doc.isModified = True
        return SketchLineList(lines)


class SketchCurves:
    def __init__(self, sketch: Sketch) -> None:
        self.sketchLines: SketchLines = SketchLines(sketch)


class Sketch(core.Base):
    def __init__(self, component: fusion.Component, plane: fusion.ConstructionPlane) -> None:
        self.parentComponent: fusion.Component = component
        self.model_plane: fusion.ConstructionPlane = plane
        self.name: str = "Sketch" + str(component.sketches.count + 1)
        self.profiles: Profiles = Profiles()
        self.sketchCurves: SketchCurves = SketchCurves(self)


class Sketches(core.Collection[Sketch]):
    def __init__(self, component: fusion.Component) -> None:
        super().__init__()
        self.model_component: fusion.Component = component

    def add(self, planarEntity: core.Base, occurrenceForCreation: fusion.Occurrence | None = None) -> Sketch:
        from . import fusion
        if occurrenceForCreation is not None:
            raise NotImplementedError("Cross-component sketch creation is not modeled")
        if not isinstance(planarEntity, fusion.ConstructionPlane):
            raise NotImplementedError("Only construction-plane sketches are modeled")
        if planarEntity.parentComponent is not self.model_component:
            raise ValueError("Foreign sketch plane")
        if planarEntity.geometry.normal.asArray() != [0, 0, 1]:
            raise NotImplementedError("Only XY-oriented sketches are modeled")
        design = self.model_component.model_design
        if design.timeline.markerPosition != design.timeline.count:
            raise NotImplementedError("Editing a rolled-back timeline is not modeled")
        sketch = Sketch(self.model_component, planarEntity)
        self.values.append(sketch)
        design.timeline.values.append(fusion.TimelineObject(sketch))
        design.model_doc.isModified = True
        return sketch


class ExtentDefinition(core.Base):
    pass


class DistanceExtentDefinition(ExtentDefinition):
    def __init__(self, distance: core.ValueInput) -> None:
        self.model_distance: core.ValueInput = distance

    @staticmethod
    def create(distance: core.ValueInput) -> DistanceExtentDefinition:
        return DistanceExtentDefinition(distance)


class ExtrudeFeatureInput(core.Base):
    def __init__(self, profile: Profile) -> None:
        self.model_profile: Profile = profile
        self.model_distance: float | None = None

    def setOneSideExtent(self, extent: ExtentDefinition, direction: int, taperAngle: core.ValueInput | None = None) -> bool:
        from .fusion import model_literal
        if not isinstance(extent, DistanceExtentDefinition):
            raise NotImplementedError("Only distance extents are modeled")
        if taperAngle is not None and model_literal(taperAngle, "rad") != 0:
            raise NotImplementedError("Tapered extrusion is not modeled")
        if direction not in (ExtentDirections.PositiveExtentDirection, ExtentDirections.NegativeExtentDirection):
            raise NotImplementedError("Only one-sided extrusion is modeled")
        distance = model_literal(extent.model_distance, "cm")
        if distance == 0:
            return False
        self.model_distance = distance * (1 if direction == ExtentDirections.PositiveExtentDirection else -1)
        return True

    def setDistanceExtent(self, isSymmetric: bool, distance: core.ValueInput) -> bool:
        # Retained only for executing the frozen pre-migration box source. This
        # deprecated member is absent from the current pinned Autodesk interface.
        if isSymmetric:
            raise NotImplementedError("Symmetric extrusion is not modeled")
        return self.setOneSideExtent(DistanceExtentDefinition.create(distance), ExtentDirections.PositiveExtentDirection)


class PhysicalProperties(core.Base):
    def __init__(self, volume: float) -> None:
        self.volume: float = volume


class BRepBody(core.Base):
    def __init__(self, feature: ExtrudeFeature, bounds: core.BoundingBox3D) -> None:
        self.model_feature: ExtrudeFeature = feature
        self.boundingBox: core.BoundingBox3D = bounds
        self.name: str = "Body" + str(feature.model_component.bRepBodies.count + 1)
        self.isVisible: bool = True
        self.objectType: str = "adsk::fusion::BRepBody"
        self.parentComponent: fusion.Component = feature.model_component
        self.entityToken: str = "model-body:" + str(uuid.uuid4())
        self.attributes: core.Attributes = core.Attributes(self.parentComponent.model_design.model_doc)

    @property
    def physicalProperties(self) -> PhysicalProperties:
        b = self.boundingBox
        return PhysicalProperties((b.maxPoint.x-b.minPoint.x) * (b.maxPoint.y-b.minPoint.y) * (b.maxPoint.z-b.minPoint.z))

    @property
    def revisionId(self) -> str:
        return hashlib.sha256(json.dumps([self.boundingBox.minPoint.asArray(),
            self.boundingBox.maxPoint.asArray(),
            sorted((a.groupName, a.name, a.value) for a in self.attributes)]).encode()).hexdigest()

    @property
    def model_active(self) -> bool:
        return self.model_feature.model_timeline_index < self.model_feature.model_component.model_design.timeline.markerPosition


class BRepBodies:
    def __init__(self) -> None:
        self.values: list[BRepBody] = []

    @property
    def count(self) -> int:
        return len(list(self))

    def __iter__(self) -> Iterator[BRepBody]:
        return (body for body in self.values if body.model_active)

    def item(self, index: int) -> BRepBody:
        return list(self)[index]


class ExtrudeFeature(core.Base):
    def __init__(self, component: fusion.Component, bounds: core.BoundingBox3D) -> None:
        self.model_component: fusion.Component = component
        self.model_timeline_index: int = component.model_design.timeline.count
        self.name: str = "Extrude" + str(component.features.extrudeFeatures.count + 1)
        self.bodies: BRepBodies = BRepBodies()
        body = BRepBody(self, bounds)
        self.bodies.values.append(body)
        component.bRepBodies.values.append(body)


class ExtrudeFeatures(core.Collection[ExtrudeFeature]):
    def __init__(self, component: fusion.Component) -> None:
        super().__init__()
        self.model_component: fusion.Component = component

    def createInput(self, profile: core.Base, operation: int) -> ExtrudeFeatureInput:
        if not isinstance(profile, Profile) or profile.model_sketch.parentComponent is not self.model_component:
            raise ValueError("Expected an owned rectangular profile")
        if operation != FeatureOperations.NewBodyFeatureOperation:
            raise NotImplementedError("Only new-body extrusion is modeled")
        return ExtrudeFeatureInput(profile)

    def add(self, input: ExtrudeFeatureInput) -> ExtrudeFeature:
        from . import fusion
        if input.model_profile.model_sketch.parentComponent is not self.model_component:
            raise ValueError("Foreign extrusion input")
        design = self.model_component.model_design
        if design.timeline.markerPosition != design.timeline.count:
            raise NotImplementedError("Editing a rolled-back timeline is not modeled")
        distance = input.model_distance
        if distance is None:
            raise ValueError("Extrusion extent is missing")
        profile = input.model_profile
        first, second = profile.model_first, profile.model_second
        origin = profile.model_sketch.model_plane.geometry.origin
        bounds = core.BoundingBox3D.create(
            core.Point3D(min(first.x, second.x)+origin.x, min(first.y, second.y)+origin.y, origin.z+min(0, distance)),
            core.Point3D(max(first.x, second.x)+origin.x, max(first.y, second.y)+origin.y, origin.z+max(0, distance)))
        feature = ExtrudeFeature(self.model_component, bounds)
        self.values.append(feature)
        self.model_component.features.values.append(feature)
        design.timeline.values.append(fusion.TimelineObject(feature))
        design.model_doc.isModified = True
        return feature
