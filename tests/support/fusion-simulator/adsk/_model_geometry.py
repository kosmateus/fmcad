"""Explicit rectangular-prism model for historical box and rollback assertions."""
from __future__ import annotations

from collections.abc import Iterator
import hashlib
import json
import math
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


class DimensionOrientations:
    AlignedDimensionOrientation: ClassVar[int] = 0
    HorizontalDimensionOrientation: ClassVar[int] = 1
    VerticalDimensionOrientation: ClassVar[int] = 2


class SketchPoint(core.Base):
    def __init__(self, sketch: Sketch, geometry: core.Point3D) -> None:
        self.objectType: str = "adsk::fusion::SketchPoint"
        self.entityToken: str = "model-sketch-point:" + str(uuid.uuid4())
        self.parentSketch: Sketch = sketch
        self.geometry: core.Point3D = geometry

    @staticmethod
    def cast(arg: object) -> SketchPoint | None:
        return arg if isinstance(arg, SketchPoint) else None

    @property
    def worldGeometry(self) -> core.Point3D:
        self.parentSketch.model_regenerate()
        return self.parentSketch.sketchToModelSpace(self.geometry)


class SketchCurve(core.Base):
    pass


class SketchLine(SketchCurve):
    def __init__(self, sketch: Sketch, start: SketchPoint, end: SketchPoint) -> None:
        self.objectType: str = "adsk::fusion::SketchLine"
        self.entityToken: str = "model-sketch-line:" + str(uuid.uuid4())
        self.parentSketch: Sketch = sketch
        self.startSketchPoint: SketchPoint = start
        self.endSketchPoint: SketchPoint = end

    @property
    def isConstruction(self) -> bool:
        return False

    @isConstruction.setter
    def isConstruction(self, value: bool) -> None:
        if value:
            raise NotImplementedError("Construction-curve profile changes are not modeled")

    @property
    def isFixed(self) -> bool:
        return False

    @isFixed.setter
    def isFixed(self, value: bool) -> None:
        if value:
            raise NotImplementedError("Sketch constraints are not modeled")


class SketchLineList(core.Collection[SketchLine]):
    pass


class ProfileCurve(core.Base):
    def __init__(self, entity: SketchLine) -> None:
        self.sketchEntity: SketchLine = entity


class ProfileLoop(core.Base):
    def __init__(self, sketch: Sketch) -> None:
        self.isOuter: bool = True
        self.profileCurves: core.Collection[ProfileCurve] = core.Collection(
            [ProfileCurve(line) for line in sketch.sketchCurves.sketchLines])


class Profile(core.Base):
    def __init__(self, sketch: Sketch, first: core.Point3D, second: core.Point3D) -> None:
        self.objectType: str = "adsk::fusion::Profile"
        self.parentSketch: Sketch = sketch
        self.profileLoops: core.Collection[ProfileLoop] = core.Collection([ProfileLoop(sketch)])
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
        if not all(math.isfinite(v) for p in (pointOne, pointTwo) for v in p.asArray()):
            raise ValueError("Rectangle points must be finite")
        if pointOne.x == pointTwo.x or pointOne.y == pointTwo.y:
            raise ValueError("Degenerate rectangle")
        corners = [core.Point3D(pointOne.x, pointOne.y, 0), core.Point3D(pointTwo.x, pointOne.y, 0),
                   core.Point3D(pointTwo.x, pointTwo.y, 0), core.Point3D(pointOne.x, pointTwo.y, 0)]
        points = [SketchPoint(self.model_sketch, p) for p in corners]
        lines = [SketchLine(self.model_sketch, points[i], points[(i+1) % 4]) for i in range(4)]
        self.values.extend(lines)
        self.model_sketch.profiles.values.append(Profile(self.model_sketch, corners[0], corners[2]))
        self.model_sketch.parentComponent.model_design.model_doc.isModified = True
        return SketchLineList(lines)


class SketchCurves:
    def __init__(self, sketch: Sketch) -> None:
        self.sketchLines: SketchLines = SketchLines(sketch)


class CoincidentConstraint(core.Base):
    def __init__(self, point: SketchPoint, entity: SketchPoint) -> None:
        self.objectType: str = "adsk::fusion::CoincidentConstraint"
        self.entityToken: str = "model-constraint:" + str(uuid.uuid4())
        self.parentSketch: Sketch = point.parentSketch
        self.point: SketchPoint = point
        self.entity: SketchPoint = entity


class GeometricConstraints(core.Collection[CoincidentConstraint]):
    def __init__(self, sketch: Sketch) -> None:
        super().__init__()
        self.model_sketch: Sketch = sketch

    def addCoincident(self, point: SketchPoint, entity: core.Base) -> CoincidentConstraint:
        sketch = self.model_sketch
        lines = sketch.sketchCurves.sketchLines
        if (not isinstance(entity, SketchPoint) or point.parentSketch is not sketch
                or entity is not sketch.originPoint or not lines.count
                or point is not lines.item(0).startSketchPoint
                or point.geometry.asArray() != [0, 0, 0]):
            raise NotImplementedError("Only an origin-anchored rectangle coincidence is modeled")
        if self.count:
            raise ValueError("Duplicate origin constraint")
        constraint = CoincidentConstraint(point, entity)
        self.values.append(constraint)
        sketch.parentComponent.model_design.model_doc.isModified = True
        return constraint


class ModelParameter(core.Base):
    def __init__(self, dimension: SketchLinearDimension, expression: str) -> None:
        self.model_dimension: SketchLinearDimension = dimension
        self.model_expression: str = expression
        self.name: str = "d" + str(dimension.parentSketch.sketchDimensions.count + 1)

    @property
    def expression(self) -> str:
        return self.model_expression

    @expression.setter
    def expression(self, expression: str) -> None:
        dimension = self.model_dimension
        sketch = dimension.parentSketch
        # Expressions are retained, evaluated from the document parameter graph.
        value = sketch.parentComponent.model_design.unitsManager.evaluateExpression(expression, "cm")
        if not math.isfinite(value) or value <= 0:
            raise ValueError("Rectangle dimensions must be positive")
        self.model_expression = expression
        sketch.model_regenerate()
        sketch.parentComponent.model_design.model_doc.isModified = True

    @property
    def value(self) -> float:
        return self.model_dimension.parentSketch.parentComponent.model_design.unitsManager.evaluateExpression(self.model_expression, "cm")


class SketchLinearDimension(core.Base):
    def __init__(self, first: SketchPoint, second: SketchPoint, orientation: int, axis: str) -> None:
        self.objectType: str = "adsk::fusion::SketchLinearDimension"
        self.entityToken: str = "model-dimension:" + str(uuid.uuid4())
        self.parentSketch: Sketch = first.parentSketch
        self.entityOne: SketchPoint = first
        self.entityTwo: SketchPoint = second
        self.orientation: int = orientation
        self.isDriving: bool = True
        self.model_axis: str = axis
        self.parameter: ModelParameter = ModelParameter(self,
            str(abs(second.geometry.x - first.geometry.x) if axis == "x" else abs(second.geometry.y - first.geometry.y)) + " cm")


class SketchDimensions(core.Collection[SketchLinearDimension]):
    def __init__(self, sketch: Sketch) -> None:
        super().__init__()
        self.model_sketch: Sketch = sketch

    def addDistanceDimension(self, pointOne: SketchPoint, pointTwo: SketchPoint,
                             orientation: int, textPoint: core.Point3D,
                             isDriving: bool = True) -> SketchLinearDimension:
        sketch = self.model_sketch
        lines = sketch.sketchCurves.sketchLines
        if not isDriving or lines.count != 4 or not sketch.geometricConstraints.count:
            raise NotImplementedError("Only driving dimensions of an anchored rectangle are modeled")
        axis = next((axis for i, axis in enumerate(("x", "y"))
                     if pointOne is lines.item(i).startSketchPoint and pointTwo is lines.item(i).endSketchPoint), None)
        expected = DimensionOrientations.HorizontalDimensionOrientation if axis == "x" else DimensionOrientations.VerticalDimensionOrientation
        if axis is None or orientation not in (DimensionOrientations.AlignedDimensionOrientation, expected):
            raise NotImplementedError("Only first/second rectangle edge dimensions are modeled")
        if (lines.item(0).endSketchPoint.geometry.x <= 0
                or lines.item(1).endSketchPoint.geometry.y <= 0):
            raise NotImplementedError("Only positive-quadrant rectangle dimensions are modeled")
        if any(d.model_axis == axis for d in self):
            raise ValueError("Duplicate rectangle dimension")
        dimension = SketchLinearDimension(pointOne, pointTwo, orientation, axis)
        self.values.append(dimension)
        sketch.parentComponent.model_design.model_doc.isModified = True
        return dimension


class Sketch(core.Base):
    def __init__(self, component: fusion.Component, plane: fusion.ConstructionPlane) -> None:
        self.parentComponent: fusion.Component = component
        self.objectType: str = "adsk::fusion::Sketch"
        self.entityToken: str = "model-sketch:" + str(uuid.uuid4())
        self.model_plane: fusion.ConstructionPlane = plane
        self.name: str = "Sketch" + str(component.sketches.count + 1)
        self.profiles: Profiles = Profiles()
        self.sketchCurves: SketchCurves = SketchCurves(self)
        self.originPoint: SketchPoint = SketchPoint(self, core.Point3D(0, 0, 0))
        self.geometricConstraints: GeometricConstraints = GeometricConstraints(self)
        self.sketchDimensions: SketchDimensions = SketchDimensions(self)

    def model_regenerate(self) -> None:
        # This is a closed-form axis-aligned rectangle, not a general constraint solver.
        for dimension in self.sketchDimensions:
            value = dimension.parameter.value
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Rectangle dimensions must remain positive")
            indices = (1, 2) if dimension.model_axis == "x" else (2, 3)
            for index in indices:
                setattr(self.sketchCurves.sketchLines.item(index).startSketchPoint.geometry,
                        dimension.model_axis, value)

    def model_coordinates_supported(self) -> None:
        component = self.parentComponent
        if (component is not component.model_design.rootComponent
                or self.model_plane is not component.xYConstructionPlane):
            raise NotImplementedError("Coordinate proof supports only the root builtin XY plane")

    def sketchToModelSpace(self, sketchCoordinate: core.Point3D) -> core.Point3D:
        self.model_coordinates_supported()
        return sketchCoordinate.copy()

    def modelToSketchSpace(self, modelCoordinate: core.Point3D) -> core.Point3D:
        self.model_coordinates_supported()
        return modelCoordinate.copy()

    @property
    def healthState(self) -> int:
        # Only a valid empty sketch or one nondegenerate literal rectangle exists.
        return 0

    @property
    def errorOrWarningMessage(self) -> str:
        return ""


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

    def addWithoutEdges(self, planarEntity: core.Base, occurrenceForCreation: fusion.Occurrence | None = None) -> Sketch:
        # Construction planes have no edges to project. Face support is rejected by add.
        return self.add(planarEntity, occurrenceForCreation)


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
        self.isSolid: bool = True
        self.model_extent: core.ValueInput | None = None
        self.model_direction: int = 1

    def setOneSideExtent(self, extent: ExtentDefinition, direction: int, taperAngle: core.ValueInput | None = None) -> bool:
        from .fusion import model_literal
        if not isinstance(extent, DistanceExtentDefinition):
            raise NotImplementedError("Only distance extents are modeled")
        if taperAngle is not None and model_literal(taperAngle, "rad") != 0:
            raise NotImplementedError("Tapered extrusion is not modeled")
        if direction not in (ExtentDirections.PositiveExtentDirection, ExtentDirections.NegativeExtentDirection):
            raise NotImplementedError("Only one-sided extrusion is modeled")
        raw = extent.model_distance.value
        units = self.model_profile.parentSketch.parentComponent.model_design.unitsManager
        distance = units.evaluateExpression(raw, "cm") if isinstance(raw, str) else raw
        if distance == 0:
            return False
        self.model_direction = 1 if direction == ExtentDirections.PositiveExtentDirection else -1
        self.model_extent = extent.model_distance
        self.model_distance = distance * self.model_direction
        return True

    def setDistanceExtent(self, isSymmetric: bool, distance: core.ValueInput) -> bool:
        # Retained only for executing the frozen pre-migration box source. This
        # deprecated member is absent from the current pinned Autodesk interface.
        if isSymmetric:
            raise NotImplementedError("Symmetric extrusion is not modeled")
        return self.setOneSideExtent(DistanceExtentDefinition.create(distance), ExtentDirections.PositiveExtentDirection)


class CalculationAccuracy:
    LowCalculationAccuracy: ClassVar[int] = 0
    MediumCalculationAccuracy: ClassVar[int] = 1
    HighCalculationAccuracy: ClassVar[int] = 2
    VeryHighCalculationAccuracy: ClassVar[int] = 3


class PhysicalProperties(core.Base):
    def __init__(self, volume: float) -> None:
        self.volume: float = volume


class BRepBody(core.Base):
    def __init__(self, feature: ExtrudeFeature, bounds: core.BoundingBox3D) -> None:
        self.model_feature: ExtrudeFeature = feature
        self.model_bounds: core.BoundingBox3D = bounds
        self.name: str = "Body" + str(feature.model_component.bRepBodies.count + 1)
        self.model_light_bulb: bool = True
        self.objectType: str = "adsk::fusion::BRepBody"
        self.parentComponent: fusion.Component = feature.model_component
        self.entityToken: str = "model-body:" + str(uuid.uuid4())
        self.attributes: core.Attributes = core.Attributes(self.parentComponent.model_design.model_doc)

    @property
    def isLightBulbOn(self) -> bool:
        return self.model_light_bulb

    @isLightBulbOn.setter
    def isLightBulbOn(self, value: bool) -> None:
        if not self.parentComponent.model_design.model_doc.isValid:
            raise ValueError("Body document is closed")
        self.model_light_bulb = value
        self.parentComponent.model_design.model_doc.isModified = True

    @property
    def isVisible(self) -> bool:
        if self.parentComponent is not self.parentComponent.model_design.rootComponent:
            raise NotImplementedError("Occurrence and ancestor visibility are not modeled")
        return self.isLightBulbOn and self.model_active

    @isVisible.setter
    def isVisible(self, value: bool) -> None:
        raise NotImplementedError("Set isLightBulbOn; direct visibility setters are not modeled")

    @property
    def boundingBox(self) -> core.BoundingBox3D:
        source = self.model_feature.model_input
        if source is None:
            return self.model_bounds
        profile = source.model_profile
        profile.parentSketch.model_regenerate()
        first, second = profile.model_first, profile.model_second
        origin = profile.parentSketch.model_plane.geometry.origin
        raw = source.model_extent.value if source.model_extent is not None else None
        if raw is None:
            raise ValueError("Missing extrusion distance")
        units = self.parentComponent.model_design.unitsManager
        distance = (units.evaluateExpression(raw, "cm") if isinstance(raw, str) else raw) * source.model_direction
        if not math.isfinite(distance) or distance == 0:
            raise ValueError("Extrusion distance must remain finite and nonzero")
        return core.BoundingBox3D.create(
            core.Point3D(min(first.x, second.x)+origin.x, min(first.y, second.y)+origin.y, origin.z+min(0, distance)),
            core.Point3D(max(first.x, second.x)+origin.x, max(first.y, second.y)+origin.y, origin.z+max(0, distance)))

    @property
    def preciseBoundingBox(self) -> core.BoundingBox3D:
        return self.boundingBox

    def getPhysicalProperties(self, accuracy: int = CalculationAccuracy.LowCalculationAccuracy) -> PhysicalProperties:
        if accuracy not in (0, 1, 2, 3):
            raise ValueError("Invalid calculation accuracy")
        return self.physicalProperties

    @property
    def volume(self) -> float:
        return self.physicalProperties.volume

    @property
    def isSolid(self) -> bool:
        return True

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
        self.model_input: ExtrudeFeatureInput | None = None
        self.model_timeline_index: int = component.model_design.timeline.count
        self.objectType: str = "adsk::fusion::ExtrudeFeature"
        self.entityToken: str = "model-extrude:" + str(uuid.uuid4())
        self.parentComponent: fusion.Component = component
        self.healthState: int = 0
        self.errorOrWarningMessage: str = ""
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
        if not input.isSolid:
            raise NotImplementedError("Surface extrusions are not modeled")
        profile = input.model_profile
        profile.model_sketch.model_regenerate()
        first, second = profile.model_first, profile.model_second
        origin = profile.model_sketch.model_plane.geometry.origin
        bounds = core.BoundingBox3D.create(
            core.Point3D(min(first.x, second.x)+origin.x, min(first.y, second.y)+origin.y, origin.z+min(0, distance)),
            core.Point3D(max(first.x, second.x)+origin.x, max(first.y, second.y)+origin.y, origin.z+max(0, distance)))
        feature = ExtrudeFeature(self.model_component, bounds)
        feature.model_input = input
        self.values.append(feature)
        self.model_component.features.values.append(feature)
        design.timeline.values.append(fusion.TimelineObject(feature))
        design.model_doc.isModified = True
        return feature
