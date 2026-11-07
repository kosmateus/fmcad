"""Analytical length parameters only; no BRep/constraint solver is implied."""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import core
from ._expressions import UNITS, Quantity, evaluate


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


class Timeline:
    count: int = 0
    markerPosition: int = 0


class Design(core.Product):
    def __init__(self, doc: core.Document) -> None:
        self.userParameters: UserParameters = UserParameters(doc)
        self.allParameters: UserParameters = self.userParameters
        self.allComponents: core.Collection[object] = core.Collection()
        self.timeline: Timeline = Timeline()
        self.exportManager: ExportManager = ExportManager(doc, self.userParameters)

    @staticmethod
    def cast(arg: object) -> Design | None:
        return arg if isinstance(arg, Design) else None
