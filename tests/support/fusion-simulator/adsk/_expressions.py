"""Small dimensional arithmetic model, not Fusion's expression language."""
from __future__ import annotations

import ast
import math
import re
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class Quantity:
    value: float
    length: int = 0
    angle: int = 0


UNITS: dict[str, Quantity] = {
    "": Quantity(1), "mm": Quantity(0.1, 1), "cm": Quantity(1, 1),
    "m": Quantity(100, 1), "in": Quantity(2.54, 1), "ft": Quantity(30.48, 1),
    "yd": Quantity(91.44, 1), "deg": Quantity(math.pi / 180, 0, 1),
    "rad": Quantity(1, 0, 1),
}
for length_unit in ("mm", "cm", "m", "in", "ft", "yd"):
    for power in (2, 3):
        quantity = Quantity(UNITS[length_unit].value ** power, power)
        UNITS[length_unit + str(power)] = quantity
        UNITS[length_unit + "^" + str(power)] = quantity

NUMBER = r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"


def evaluate(expression: str, unit: str, resolve: Callable[[str], Quantity]) -> Quantity:
    expected = UNITS.get(unit)
    if expected is None:
        raise NotImplementedError("Unsupported parameter unit: " + unit)
    source = re.sub(r"(?<![A-Za-z0-9_.])(" + NUMBER + r")\s*(mm|cm|m|in|ft|yd)\s*\^([23])\b",
                    r"(\1 * _unit_\2\3)", expression)
    source = re.sub(r"(?<![A-Za-z0-9_.])(" + NUMBER + r")\s*(mm|cm|m|in|ft|yd|deg|rad)\b",
                    r"(\1 * _unit_\2)", source)
    tree = ast.parse(source.strip(), mode="eval")
    if sum(1 for _ in ast.walk(tree)) > 100:
        raise NotImplementedError("Expression exceeds model complexity limit")

    def visit(node: ast.AST) -> Quantity:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return Quantity(float(node.value))
        if isinstance(node, ast.Name):
            if node.id.startswith("_unit_"):
                return UNITS[node.id[6:]]
            return resolve(node.id)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return Quantity(value.value * (-1 if isinstance(node.op, ast.USub) else 1), value.length, value.angle)
        if isinstance(node, ast.BinOp):
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, (ast.Add, ast.Sub)):
                if (left.length, left.angle) != (right.length, right.angle):
                    raise ValueError("Incompatible dimensions")
                return Quantity(left.value + right.value * (-1 if isinstance(node.op, ast.Sub) else 1),
                                left.length, left.angle)
            if isinstance(node.op, ast.Mult):
                return Quantity(left.value * right.value, left.length + right.length, left.angle + right.angle)
            if isinstance(node.op, ast.Div):
                return Quantity(left.value / right.value, left.length - right.length, left.angle - right.angle)
        raise NotImplementedError("Expression syntax is not modeled")

    value = visit(tree.body)
    if (value.length, value.angle) == (0, 0) and (expected.length, expected.angle) != (0, 0):
        raise NotImplementedError("Implicit display units are not modeled; include an explicit unit")
    if (value.length, value.angle) != (expected.length, expected.angle):
        raise ValueError("Expression and parameter units are incompatible")
    if not math.isfinite(value.value):
        raise ValueError("Non-finite parameter")
    return value
