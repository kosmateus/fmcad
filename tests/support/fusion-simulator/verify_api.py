"""Check supported call shapes against a verified upstream API snapshot.

Run the repository's adsk-refresh --dev verification before this tool. This is
interface coverage, not proof of runtime behavior or complete SDK equivalence.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

METHODS: dict[str, dict[str, list[str]]] = {
    "core": {"Appearances": ["addByCopy", "itemById", "itemByName"], "Materials": ["addByCopy", "itemById", "itemByName"], "MaterialLibraries": ["itemById", "itemByName"], "Properties": ["itemById", "itemByName"], "BoundingBox3D": ["create"], "Point3D": ["create", "asArray", "copy"], "Vector3D": ["create", "asArray"],
             "UnitsManager": ["isValidExpression", "evaluateExpression"],
             "Attributes": ["add", "itemByName", "itemsByGroup"],
             "Plane": ["create"], "Matrix3D": ["create", "asArray"],
             "Camera": ["create", "getExtents", "setExtents"], "Application": ["get"], "Documents": ["add", "open"], "Document": ["activate", "close", "saveAs", "save"],
             "Products": ["itemByProductType"], "ValueInput": ["createByString", "createByReal"],
             "Data": ["findFileById"], "DataProjects": ["itemById"], "DataFolders": ["itemById", "itemByName", "add"],
             "DataFiles": ["itemById"], "DataFile": ["deleteMe"]},
    "fusion": {"BRepBody": ["getPhysicalProperties"], "SketchPoint": ["cast"], "GeometricConstraints": ["addCoincident"],
               "SketchDimensions": ["addDistanceDimension"], "Sketches": ["add", "addWithoutEdges"], "SketchLines": ["addTwoPointRectangle"],
               "Sketch": ["sketchToModelSpace", "modelToSketchSpace"],
               "DistanceExtentDefinition": ["create"], "ExtrudeFeatureInput": ["setOneSideExtent"],
               "ExtrudeFeatures": ["createInput", "add"], "ConstructionPlane": ["deleteMe"], "ConstructionPlanes": ["createInput", "add", "itemByName"],
               "ConstructionPlaneInput": ["setByOffset", "setByTwoPlanes", "setByAngle"],
               "Occurrences": ["addNewComponent"],
               "UserParameter": ["deleteMe"], "UserParameters": ["add", "itemByName"], "ExportManager": ["createFusionArchiveExportOptions", "execute"],
               "Design": ["cast", "findEntityByToken", "computeAll"]},
}

PARAMETER_PROPERTIES = ["name", "expression", "value", "unit", "comment"]
PROPERTIES = [("core", "Property", "core", "Property", ["id", "name", "isReadOnly", "parent"]),
              ("fusion", "BRepBody", "fusion", "BRepBody", ["appearance", "material", "faces", "edges"]),
              ("fusion", "BaseComponent", "fusion", "Component", ["allOccurrences"]),("core", "Appearance", "core", "Appearance", ["id", "name", "parent", "appearanceProperties"]),
              ("core", "MaterialLibrary", "core", "MaterialLibrary", ["appearances"]),
              ("fusion", "Design", "fusion", "Design", ["appearances"]), ("core", "Material", "core", "Material", ["id", "name", "description", "parent", "materialProperties"]),
              ("core", "MaterialLibrary", "core", "MaterialLibrary", ["id", "name", "materials"]),
              ("core", "Application", "core", "Application", ["materialLibraries"]),
              ("fusion", "Design", "fusion", "Design", ["materials"]), ("fusion", "Component", "fusion", "Component", ["attributes"]),
              ("fusion", "BRepBody", "fusion", "BRepBody", ["isLightBulbOn", "isVisible"]), ("core", "Camera", "core", "Camera", ["eye", "target", "upVector", "cameraType", "perspectiveAngle", "viewOrientation", "isFitView", "isSmoothTransition"]),
              ("core", "Viewport", "core", "Viewport", ["camera", "parentDocument"]),
              ("core", "Application", "core", "Application", ["activeViewport"]), ("fusion", "Parameter", "fusion", "UserParameter", PARAMETER_PROPERTIES),
              ("fusion", "SketchPoint", "fusion", "SketchPoint", ["worldGeometry"]),
              ("fusion", "Sketch", "fusion", "Sketch", ["healthState", "errorOrWarningMessage", "isLightBulbOn"]),
              ("fusion", "SketchCurve", "fusion", "SketchLine", ["isConstruction"]),
              ("fusion", "SketchEntity", "fusion", "SketchLine", ["isFixed"]),
              ("core", "Attribute", "core", "Attribute", ["value"]),
              ("fusion", "FusionUnitsManager", "fusion", "FusionUnitsManager", ["distanceDisplayUnits"]),
              ("core", "UnitsManager", "fusion", "FusionUnitsManager", ["defaultLengthUnits"])]


def property_accessors(file: Path, cls: str, name: str) -> list[ast.FunctionDef]:
    tree = ast.parse(file.read_text(encoding="utf-8"))
    definition = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == cls)
    return [node for node in definition.body if isinstance(node, ast.FunctionDef) and node.name == name]


def methods(file: Path) -> dict[str, dict[str, ast.FunctionDef]]:
    parsed = ast.parse(file.read_text(encoding="utf-8"))
    return {node.name: {f.name: f for f in node.body if isinstance(f, ast.FunctionDef)}
            for node in parsed.body if isinstance(node, ast.ClassDef)}


def shape(function: ast.FunctionDef) -> tuple[list[str], int, list[str]]:
    return ([arg.arg for arg in function.args.posonlyargs + function.args.args],
            len(function.args.defaults), [ast.unparse(d) for d in function.decorator_list])


def main(snapshot: Path) -> None:
    supported = 0
    for module, classes in METHODS.items():
        upstream = methods(snapshot / "adsk" / (module + ".py"))
        model = methods(Path(__file__).parent / "adsk" / (module + ".py"))
        if module == "fusion":
            model.update(methods(Path(__file__).parent / "adsk/_model_geometry.py"))
        for cls, names in classes.items():
            for name in names:
                expected, actual = upstream[cls][name], model[cls][name]
                if shape(expected) != shape(actual):
                    raise ValueError(f"Call shape differs: {module}.{cls}.{name}: {shape(expected)} != {shape(actual)}")
                supported += 1
    for cls in ("DataProjects", "DataFolders", "DataFiles"):
        expected = methods(snapshot / "adsk/core.py")[cls]["asArray"]
        actual = methods(Path(__file__).parent / "adsk/core.py")["Collection"]["asArray"]
        if shape(expected) != shape(actual):
            raise ValueError("Collection call shape differs: " + cls + ".asArray")
        supported += 1
    accessors = 0
    for upstream_module, upstream_class, model_module, model_class, names in PROPERTIES:
        for name in names:
            expected = property_accessors(snapshot / "adsk" / (upstream_module + ".py"), upstream_class, name)
            model_file = Path(__file__).parent / "adsk" / (model_module + ".py")
            if model_module == "fusion" and model_class not in methods(model_file):
                model_file = model_file.with_name("_model_geometry.py")
            actual = property_accessors(model_file, model_class, name)
            if not actual or [shape(fn) for fn in actual] != [shape(fn) for fn in expected]:
                raise ValueError("Property accessor differs: " + model_class + "." + name)
            accessors += len(actual)
    print(f"Verified {supported} method and {accessors} property accessor shapes against {snapshot.name}; behavior still requires live qualification")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("Provide one verified API snapshot directory")
    main(Path(sys.argv[1]))
