"""Check supported call shapes against a verified upstream API snapshot.

Run the repository's adsk-refresh --dev verification before this tool. This is
interface coverage, not proof of runtime behavior or complete SDK equivalence.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

METHODS: dict[str, dict[str, list[str]]] = {
    "core": {"Application": ["get"], "Documents": ["add"], "Document": ["activate", "close", "saveAs", "save"],
             "Products": ["itemByProductType"], "ValueInput": ["createByString", "createByReal"],
             "Data": ["findFileById"], "DataProjects": ["itemById"], "DataFolders": ["itemById", "add"],
             "DataFiles": ["itemById"], "DataFile": ["deleteMe"]},
    "fusion": {"UserParameter": ["deleteMe"], "UserParameters": ["add", "itemByName"], "ExportManager": ["createFusionArchiveExportOptions", "execute"],
               "Design": ["cast"]},
}

PARAMETER_PROPERTIES = ["name", "expression", "value", "unit", "comment"]


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
        for cls, names in classes.items():
            for name in names:
                expected, actual = upstream[cls][name], model[cls][name]
                if shape(expected) != shape(actual):
                    raise ValueError(f"Call shape differs: {module}.{cls}.{name}: {shape(expected)} != {shape(actual)}")
                supported += 1
    accessors = 0
    for name in PARAMETER_PROPERTIES:
        expected = property_accessors(snapshot / "adsk/fusion.py", "Parameter", name)
        actual = property_accessors(Path(__file__).parent / "adsk/fusion.py", "UserParameter", name)
        if not actual or [shape(fn) for fn in actual] != [shape(fn) for fn in expected]:
            raise ValueError("Parameter property accessor differs: " + name)
        accessors += len(actual)
    print(f"Verified {supported} method and {accessors} property accessor shapes against {snapshot.name}; behavior still requires live qualification")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("Provide one verified API snapshot directory")
    main(Path(sys.argv[1]))
