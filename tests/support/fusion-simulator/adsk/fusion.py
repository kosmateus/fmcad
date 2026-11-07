"""Analytical length parameters only; no BRep/constraint solver is implied."""
from __future__ import annotations

import hashlib
import json
import uuid
import math
import re
from pathlib import Path
from typing import ClassVar

from . import core
from ._expressions import UNITS, Quantity, evaluate
from ._model_geometry import (BRepBodies as BRepBodies, BRepBody as BRepBody,
    PhysicalProperties as PhysicalProperties, Sketch as Sketch, Sketches as Sketches,
    SketchCurves as SketchCurves, SketchLines as SketchLines, SketchLine as SketchLine,
    SketchLineList as SketchLineList, SketchPoint as SketchPoint, Profile as Profile,
    Profiles as Profiles, FeatureOperations as FeatureOperations,
    ExtentDirections as ExtentDirections, ExtentDefinition as ExtentDefinition,
    DistanceExtentDefinition as DistanceExtentDefinition,
    ExtrudeFeature as ExtrudeFeature, ExtrudeFeatures as ExtrudeFeatures,
    ExtrudeFeatureInput as ExtrudeFeatureInput)


class UserParameter(core.Base):
    def __init__(self, owner: UserParameters, name: str, expression: str, unit: str, comment: str) -> None:
        self.userParameters: UserParameters = owner
        self.model_name: str = name
        self.model_expression: str = expression
        self.model_unit: str = unit
        self.model_comment: str = comment
        self.isValid: bool = True
        self.model_delete_calls: int = 0

    def _valid(self) -> None:
        if not self.isValid:
            raise RuntimeError("Deleted parameter")

    @property
    def unit(self) -> str:
        self._valid()
        return self.model_unit

    @property
    def comment(self) -> str:
        self._valid()
        return self.model_comment

    @comment.setter
    def comment(self, value: str) -> None:
        self._valid()
        self.model_comment = value
        self.userParameters.doc.isModified = True

    @property
    def name(self) -> str:
        self._valid()
        return self.model_name

    @name.setter
    def name(self, value: str) -> None:
        self._valid()
        self.userParameters.rename(self, value)

    @property
    def expression(self) -> str:
        self._valid()
        return self.model_expression

    @expression.setter
    def expression(self, value: str) -> None:
        self._valid()
        self.userParameters.update(self, value)

    @property
    def value(self) -> float:
        self._valid()
        return self.userParameters.evaluate(self.model_name, set()).value

    @value.setter
    def value(self, value: float) -> None:
        self._valid()
        unit = UNITS[self.unit]
        internal_unit = "cm" if unit.length else "rad" if unit.angle else ""
        self.userParameters.update(self, str(value) + (" " + internal_unit if internal_unit else ""))

    def deleteMe(self) -> bool:
        self._valid()
        self.model_delete_calls += 1
        # The pinned Autodesk docstring warns that true can be returned when a
        # dependent prevents deletion. Keep this conservative fault in the model.
        if any(re.search(r"\b" + re.escape(self.model_name) + r"\b", p.model_expression)
               for p in self.userParameters if p is not self):
            return True
        self.userParameters.values.remove(self)
        self.isValid = False
        self.userParameters.doc.isModified = True
        return True


class UserParameters(core.Collection[UserParameter]):
    def __init__(self, doc: core.Document) -> None:
        super().__init__()
        self.doc: core.Document = doc

    def itemByName(self, name: str) -> UserParameter | None:
        return next((p for p in self if p.name == name), None)

    def validate_name(self, name: str, current: UserParameter | None = None) -> None:
        if (not re.fullmatch(r"[A-Za-z][A-Za-z_0-9]*", name) or name in UNITS
                or any(p is not current and p.name == name for p in self)):
            raise ValueError("Invalid or duplicate parameter name")

    def evaluate(self, name: str, active: set[str]) -> Quantity:
        if name in active:
            raise ValueError("Cyclic parameter expression")
        parameter = self.itemByName(name)
        if parameter is None:
            raise ValueError("Unknown parameter: " + name)
        return evaluate(parameter.model_expression, parameter.unit,
                        lambda other: self.evaluate(other, active | {name}))

    def update(self, parameter: UserParameter, expression: str) -> None:
        previous = parameter.model_expression
        parameter.model_expression = expression
        try:
            for p in self:
                _ = self.evaluate(p.name, set())
        except Exception:
            parameter.model_expression = previous
            raise
        self.doc.isModified = True

    def rename(self, parameter: UserParameter, name: str) -> None:
        self.validate_name(name, parameter)
        old_name = parameter.model_name
        for p in self:
            p.model_expression = re.sub(r"\b" + re.escape(old_name) + r"\b", name, p.model_expression)
        parameter.model_name = name
        self.doc.isModified = True

    def add(self, name: str, value: core.ValueInput, units: str, comment: str) -> UserParameter:
        self.validate_name(name)
        if units not in UNITS:
            raise NotImplementedError("Only scalar, length and angle parameters are modeled")
        if isinstance(value.value, str):
            expression = value.value
        else:
            dimension = UNITS[units]
            internal_unit = "cm" if dimension.length else "rad" if dimension.angle else ""
            expression = str(value.value) + (" " + internal_unit if internal_unit else "")
        parameter = UserParameter(self, name, expression, units, comment)
        self.values.append(parameter)
        try:
            _ = self.evaluate(name, set())
        except Exception:
            self.values.remove(parameter)
            raise
        self.doc.isModified = True
        return parameter


class ExportOptions(core.Base):
    pass


class FusionArchiveExportOptions(ExportOptions):
    def __init__(self, filename: str) -> None:
        self.filename: str = filename


class ExportManager(core.Base):
    def __init__(self, doc: core.Document, parameters: UserParameters) -> None:
        self.doc: core.Document = doc
        self.parameters: UserParameters = parameters

    def createFusionArchiveExportOptions(self, filename: str,
                                        geometry: core.Base | None = None) -> FusionArchiveExportOptions:
        if geometry is not None:
            raise NotImplementedError("Partial geometry export is not modeled")
        return FusionArchiveExportOptions(filename)

    def execute(self, exportOptions: ExportOptions) -> bool:
        if not isinstance(exportOptions, FusionArchiveExportOptions):
            raise NotImplementedError("Export format is not modeled")
        # This marker is intentional: bytes are a test state, NEVER a real Autodesk archive.
        payload: dict[str, object] = {"format": "fmcad-simulator-state-v1", "nativeF3d": False,
                                     "creationId": self.doc.creationId, "name": self.doc.name,
                                     "parameters": [{"name": p.name, "value": p.value} for p in self.parameters]}
        _ = Path(exportOptions.filename).write_text(json.dumps(payload), encoding="utf-8")
        return True


class DistanceUnits:
    MillimeterDistanceUnits: ClassVar[int] = 0
    CentimeterDistanceUnits: ClassVar[int] = 1
    MeterDistanceUnits: ClassVar[int] = 2
    InchDistanceUnits: ClassVar[int] = 3
    FootDistanceUnits: ClassVar[int] = 4
    YardDistanceUnits: ClassVar[int] = 5


class FusionUnitsManager(core.UnitsManager):
    def __init__(self, doc: core.Document) -> None:
        self.model_doc: core.Document = doc
        self.model_distance: int = DistanceUnits.MillimeterDistanceUnits

    @property
    def distanceDisplayUnits(self) -> int:
        return self.model_distance

    @distanceDisplayUnits.setter
    def distanceDisplayUnits(self, value: int) -> None:
        if value not in (0, 1, 2, 3, 4, 5):
            raise NotImplementedError("Display unit is not modeled")
        self.model_distance = value
        self.model_doc.isModified = True

    @property
    def defaultLengthUnits(self) -> str:
        return {0: "mm", 1: "cm", 2: "m", 3: "in", 4: "ft", 5: "yd"}[self.model_distance]


class FeatureHealthStates:
    HealthyFeatureHealthState: ClassVar[int] = 0


class TimelineObject(core.Base):
    def __init__(self, entity: ConstructionPlane | Occurrence | Sketch | ExtrudeFeature) -> None:
        self.entity: ConstructionPlane | Occurrence | Sketch | ExtrudeFeature = entity
        self.healthState: int = FeatureHealthStates.HealthyFeatureHealthState
        self.errorOrWarningMessage: str = ""

    @property
    def name(self) -> str:
        return self.entity.name


class Timeline(core.Collection[TimelineObject]):
    def __init__(self, doc: core.Document) -> None:
        super().__init__()
        self.model_doc: core.Document = doc
        self.model_marker: int | None = None

    @property
    def markerPosition(self) -> int:
        return self.count if self.model_marker is None else self.model_marker

    @markerPosition.setter
    def markerPosition(self, value: int) -> None:
        if value < 0 or value > self.count:
            raise ValueError("Timeline marker out of range")
        old = self.markerPosition
        if any(not isinstance(item.entity, (Sketch, ExtrudeFeature)) for item in self.values[min(old, value):max(old, value)]):
            raise NotImplementedError("Only rectangular sketch/extrude rollback is modeled")
        self.model_marker = None if value == self.count else value
        if value != old:
            self.model_doc.isModified = True


class ConstructionAxis(core.Base):
    def __init__(self, direction: core.Vector3D) -> None:
        self.model_direction: core.Vector3D = direction


class ConstructionPlane(core.Base):
    def __init__(self, owner: Component, geometry: core.Plane, name: str, origin: bool = False) -> None:
        self.parentComponent: Component = owner
        self.geometry: core.Plane = geometry
        self.name: str = name
        self.isValid: bool = True
        self.model_origin: bool = origin
        self.model_dependencies: list[ConstructionPlane] = []

    def deleteMe(self) -> bool:
        if not self.isValid or self.model_origin:
            return False
        planes = self.parentComponent.constructionPlanes
        if any(self in p.model_dependencies for p in planes):
            raise NotImplementedError("Cascading plane deletion is not modeled")
        planes.values.remove(self)
        timeline = self.parentComponent.model_design.timeline
        timeline.values[:] = [item for item in timeline if item.entity is not self]
        self.isValid = False
        self.parentComponent.model_design.model_doc.isModified = True
        return True


def model_literal(value: core.ValueInput, units: str) -> float:
    def unsupported(name: str) -> Quantity:
        raise NotImplementedError("Parameter-driven geometry regeneration is not modeled: " + name)
    if isinstance(value.value, str):
        return evaluate(value.value, units, unsupported).value
    if not math.isfinite(value.value):
        raise ValueError("Non-finite geometry input")
    return value.value


class ConstructionPlaneInput(core.Base):
    def __init__(self, component: Component) -> None:
        self.model_component: Component = component
        self.model_geometry: core.Plane | None = None
        self.model_dependencies: list[ConstructionPlane] = []

    def model_plane(self, entity: core.Base) -> ConstructionPlane:
        if (not isinstance(entity, ConstructionPlane) or not entity.isValid
                or entity.parentComponent is not self.model_component):
            raise NotImplementedError("Only owned construction planes are modeled")
        return entity

    def setByOffset(self, planarEntity: core.Base, offset: core.ValueInput) -> bool:
        plane = self.model_plane(planarEntity)
        distance = model_literal(offset, "cm")
        origin, normal = plane.geometry.origin, plane.geometry.normal
        self.model_geometry = core.Plane(core.Point3D(origin.x + normal.x * distance,
            origin.y + normal.y * distance, origin.z + normal.z * distance), normal)
        self.model_dependencies = [plane]
        return True

    def setByTwoPlanes(self, planarEntityOne: core.Base, planarEntityTwo: core.Base) -> bool:
        first, second = self.model_plane(planarEntityOne), self.model_plane(planarEntityTwo)
        a, b = first.geometry, second.geometry
        if any(abs(x-y) > 1e-9 for x, y in zip(a.normal.asArray(), b.normal.asArray())):
            raise NotImplementedError("Only parallel midplanes are modeled")
        displacement = [y-x for x, y in zip(a.origin.asArray(), b.origin.asArray())]
        if abs(sum(x*y for x,y in zip(displacement, a.normal.asArray()))) < 1e-9:
            return False
        self.model_geometry = core.Plane(core.Point3D((a.origin.x+b.origin.x)/2,
            (a.origin.y+b.origin.y)/2, (a.origin.z+b.origin.z)/2), a.normal)
        self.model_dependencies = [first, second]
        return True

    def setByAngle(self, linearEntity: core.Base, angle: core.ValueInput, planarEntity: core.Base) -> bool:
        plane = self.model_plane(planarEntity)
        if not isinstance(linearEntity, ConstructionAxis):
            raise NotImplementedError("Only construction axes are modeled")
        origin = plane.geometry.origin
        if any(abs(x) > 1e-9 for x in origin.asArray()):
            raise NotImplementedError("Only planes through the origin support modeled angle input")
        axis, n = linearEntity.model_direction, plane.geometry.normal
        dot = axis.x*n.x + axis.y*n.y + axis.z*n.z
        if abs(dot) > 1e-9:
            return False
        theta = model_literal(angle, "rad")
        c, sine = math.cos(theta), math.sin(theta)
        normal = core.Vector3D(n.x*c+(axis.y*n.z-axis.z*n.y)*sine,
            n.y*c+(axis.z*n.x-axis.x*n.z)*sine, n.z*c+(axis.x*n.y-axis.y*n.x)*sine)
        self.model_geometry = core.Plane(origin, normal)
        self.model_dependencies = [plane]
        return True


class ConstructionPlanes(core.Collection[ConstructionPlane]):
    def __init__(self, component: Component) -> None:
        super().__init__()
        self.component: Component = component

    def createInput(self, occurrenceForCreation: Occurrence | None = None) -> ConstructionPlaneInput:
        if occurrenceForCreation is not None:
            raise NotImplementedError("Cross-component plane creation is not modeled")
        return ConstructionPlaneInput(self.component)

    def add(self, input: ConstructionPlaneInput) -> ConstructionPlane | None:
        timeline = self.component.model_design.timeline
        if timeline.markerPosition != timeline.count:
            raise NotImplementedError("Editing a rolled-back timeline is not modeled")
        if input.model_component is not self.component or input.model_geometry is None:
            return None
        plane = ConstructionPlane(self.component, input.model_geometry, "Plane" + str(self.count+1))
        plane.model_dependencies = list(input.model_dependencies)
        self.values.append(plane)
        self.component.model_design.timeline.values.append(TimelineObject(plane))
        self.component.model_design.model_doc.isModified = True
        return plane

    def itemByName(self, name: str) -> ConstructionPlane | None:
        return next((p for p in self if p.name == name), None)


class Occurrence(core.Base):
    def __init__(self, component: Component) -> None:
        self.component: Component = component

    @property
    def name(self) -> str:
        return self.component.name + ":1"


class Occurrences(core.Collection[Occurrence]):
    def __init__(self, component: Component) -> None:
        super().__init__()
        self.model_component: Component = component

    def addNewComponent(self, transform: core.Matrix3D) -> Occurrence:
        timeline = self.model_component.model_design.timeline
        if timeline.markerPosition != timeline.count:
            raise NotImplementedError("Editing a rolled-back timeline is not modeled")
        if transform.asArray() != core.Matrix3D.create().asArray():
            raise NotImplementedError("Only identity component placement is modeled")
        design = self.model_component.model_design
        component = Component(design, "Component" + str(design.allComponents.count))
        occurrence = Occurrence(component)
        self.values.append(occurrence)
        design.allComponents.values.append(component)
        design.timeline.values.append(TimelineObject(occurrence))
        design.model_doc.isModified = True
        return occurrence


class Features(core.Collection[object]):
    def __init__(self, component: Component) -> None:
        super().__init__()
        self.deriveFeatures: core.Collection[object] = core.Collection()
        self.extrudeFeatures: ExtrudeFeatures = ExtrudeFeatures(component)


class Component(core.Base):
    def __init__(self, design: Design, name: str | None = None) -> None:
        self.model_design: Design = design
        self.model_name: str | None = name
        self.model_id: str = str(uuid.uuid4())
        self.occurrences: Occurrences = Occurrences(self)
        self.constructionPlanes: ConstructionPlanes = ConstructionPlanes(self)
        self.bRepBodies: BRepBodies = BRepBodies()
        self.features: Features = Features(self)
        self.sketches: Sketches = Sketches(self)
        self.xYConstructionPlane: ConstructionPlane = ConstructionPlane(self,
            core.Plane(core.Point3D(0, 0, 0), core.Vector3D(0, 0, 1)), "XY", True)
        self.xZConstructionPlane: ConstructionPlane = ConstructionPlane(self,
            core.Plane(core.Point3D(0, 0, 0), core.Vector3D(0, 1, 0)), "XZ", True)
        self.yZConstructionPlane: ConstructionPlane = ConstructionPlane(self,
            core.Plane(core.Point3D(0, 0, 0), core.Vector3D(1, 0, 0)), "YZ", True)
        self.xConstructionAxis: ConstructionAxis = ConstructionAxis(core.Vector3D(1, 0, 0))
        self.yConstructionAxis: ConstructionAxis = ConstructionAxis(core.Vector3D(0, 1, 0))
        self.zConstructionAxis: ConstructionAxis = ConstructionAxis(core.Vector3D(0, 0, 1))

    @property
    def id(self) -> str:
        return self.model_id

    @property
    def revisionId(self) -> str:
        # Stable readback; modeled edits change the broker's optimistic snapshot.
        state = dict(name=self.name,
            units=self.model_design.unitsManager.defaultLengthUnits,
            planes=[dict(name=p.name, origin=p.geometry.origin.asArray(),
                         normal=p.geometry.normal.asArray()) for p in self.constructionPlanes],
            occurrences=[dict(id=o.component.id, name=o.component.name) for o in self.occurrences],
            sketches=[dict(name=s.name, profiles=[dict(first=p.model_first.asArray(),
                second=p.model_second.asArray()) for p in s.profiles]) for s in self.sketches],
            bodies=[dict(name=b.name, revision=b.revisionId) for b in self.bRepBodies])
        return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()

    @property
    def name(self) -> str:
        return self.model_design.model_doc.name if self.model_name is None else self.model_name

    @name.setter
    def name(self, value: str) -> None:
        self.model_name = value
        self.model_design.model_doc.isModified = True


class Design(core.Product):
    def __init__(self, doc: core.Document) -> None:
        self.model_doc: core.Document = doc
        self.userParameters: UserParameters = UserParameters(doc)
        self.allParameters: UserParameters = self.userParameters
        self.allComponents: core.Collection[Component] = core.Collection()
        self.timeline: Timeline = Timeline(doc)
        self.unitsManager: FusionUnitsManager = FusionUnitsManager(doc)
        self.rootComponent: Component = Component(self)
        self.allComponents.values.append(self.rootComponent)
        self.exportManager: ExportManager = ExportManager(doc, self.userParameters)

    @staticmethod
    def cast(arg: object) -> Design | None:
        return arg if isinstance(arg, Design) else None
