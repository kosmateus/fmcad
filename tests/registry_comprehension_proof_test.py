"""Discovered behavioral contracts for proof-bound registry rewrites."""
import ast
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "runtime/python/entrypoints/dependency_facts.py"
spec = importlib.util.spec_from_file_location("dependency_facts", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SOURCE = """\
def handler(ctx, data):
    return data
CAD_HANDLERS.update({key: handler for key in ('keep', 'drop')})
"""
OBSERVER = """\
class Observer:
    def update(self, mapping):
        self.seen = len(mapping)
CAD_HANDLERS = Observer()
"""


def expansions(source, context=()):
    tree = ast.parse(source)
    functions = {
        node.name: [node]
        for node in tree.body if isinstance(node, ast.FunctionDef)
    }
    return module.registry_expansions(
        {"id": "fixture", "source": source}, tree, functions, context)


def select_keep(source, rows):
    if not rows:
        return source
    row, = rows
    replacement = "{" + ", ".join(
        entry["source"] for entry in row["entries"]
        if entry["operation"] == "keep") + "}"
    data = source.encode()
    return (data[:row["byteStart"]] + replacement.encode()
            + data[row["byteEnd"]:]).decode()


class RegistryComprehensionProof(unittest.TestCase):
    def analysed_registrations(self, source):
        result = module.analyse({
            "source": "def run(context):\n    pass\n",
            "generated": True,
            "specialize": True,
            "units": [{
                "id": "core", "filename": "<registry-consumer>",
                "source": source, "dependencies": [],
            }],
        })
        self.assertFalse(result["unsupported"])
        return [row for row in result["facts"]["definitions"]
                if row.get("registration")]

    def test_unknown_consumer_initialization_is_not_a_removal_opportunity(self):
        prefix = """\
count = 0
class Observer:
    def update(self, mapping):
        global count
        count += len(mapping)
CAD_HANDLERS = Observer()
def a(ctx, data):
    return count
def b(ctx, data):
    return 0
"""
        for suffix in [
                "CAD_HANDLERS.update({'keep': a, 'drop': b})\n",
                "CAD_HANDLERS.update({'keep': a})\n"
                "CAD_HANDLERS.update({key: b for key in ('drop', 'drop2')})\n"]:
            with self.subTest(suffix=suffix):
                self.assertEqual(self.analysed_registrations(prefix + suffix), [])

    def test_analysed_injected_registry_retains_safe_removal_facts(self):
        rows = self.analysed_registrations(SOURCE)
        self.assertTrue(any("keep" in row["registration"] for row in rows))

    def test_rebound_consumer_observes_the_original_mapping(self):
        source = OBSERVER + SOURCE
        rows = expansions(source)
        original, selected = {}, {}
        exec(source, original)
        exec(select_keep(source, rows), selected)
        self.assertEqual(original["CAD_HANDLERS"].seen, 2)
        self.assertEqual(selected["CAD_HANDLERS"].seen, 2)
        self.assertEqual(rows, [])

    def test_peer_rebinding_cannot_bypass_the_consumer_proof(self):
        rows = expansions(SOURCE, [ast.parse(OBSERVER)])
        original, selected = {}, {}
        exec(OBSERVER + SOURCE, original)
        exec(OBSERVER + select_keep(SOURCE, rows), selected)
        self.assertEqual(selected["CAD_HANDLERS"].seen,
                         original["CAD_HANDLERS"].seen)
        self.assertEqual(rows, [])

    def test_proven_injected_registry_keeps_selected_handler_behavior(self):
        rows = expansions(SOURCE)
        self.assertEqual(len(rows), 1)
        original, selected = {"CAD_HANDLERS": {}}, {"CAD_HANDLERS": {}}
        exec(SOURCE, original)
        exec(select_keep(SOURCE, rows), selected)
        self.assertEqual(selected["CAD_HANDLERS"]["keep"](None, 5),
                         original["CAD_HANDLERS"]["keep"](None, 5))
        self.assertNotIn("drop", selected["CAD_HANDLERS"])


if __name__ == "__main__":
    unittest.main()
