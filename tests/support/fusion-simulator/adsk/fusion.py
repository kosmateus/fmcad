"""Analytical length parameters only; no BRep/constraint solver is implied."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from . import core


class UserParameter(core.Base):
    def __init__(self, name: str, expression: str, value: float, unit: str, comment: str) -> None:
        self.name: str = name
        self.expression: str = expression
        self.value: float = value
        self.unit: str = unit
        self.comment: str = comment


class UserParameters(core.Collection[UserParameter]):
    def __init__(self, doc: core.Document) -> None:
        super().__init__()
        self.doc: core.Document = doc

    def itemByName(self, name: str) -> UserParameter | None:
        return next((p for p in self if p.name == name), None)

    def add(self, name: str, value: core.ValueInput, units: str, comment: str) -> UserParameter:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name) or self.itemByName(name) is not None:
            raise ValueError("Invalid or duplicate parameter name")
        if units not in ("mm", "cm", "m"):
            raise NotImplementedError("Only length parameters are modeled")
        expression = str(value.value)
        if isinstance(value.value, str):
            match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|m)\s*", expression)
            if match is None:
                raise NotImplementedError("Expressions/references are not modeled; use a literal length")
            # Fusion's internal unit of length is cm. Independent of fmcad conversion code.
            magnitude = float(match.group(1))
            internal = magnitude * {"mm": 0.1, "cm": 1.0, "m": 100.0}[match.group(2)]
        else:
            internal = value.value
        if not math.isfinite(internal):
            raise ValueError("Non-finite parameter")
        parameter = UserParameter(name, expression, internal, units, comment)
        self.values.append(parameter)
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
