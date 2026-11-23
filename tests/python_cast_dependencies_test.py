"""Type dependencies are may-references, not permission to rewrite calls."""
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "dependency_facts", ROOT / "runtime/python/entrypoints/dependency_facts.py")
PARSER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARSER)


class CastDependenciesTest(unittest.TestCase):
    def analyse(self, source, other=""):
        return PARSER.analyse({
            "source": "def run(context):\n    context.call('keep', {})\n",
            "generated": True,
            "units": [
                {"id": "core", "filename": "<core>", "dependencies": [],
                 "source": source},
                {"id": "types", "filename": "<types>", "dependencies": [],
                 "source": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n"
                           "    class Candidate:\n        pass\n"},
                {"id": "other", "filename": "<other>", "dependencies": [],
                 "source": other},
            ],
        })["facts"]

    def test_rebound_cast_keeps_string_type_dependency(self):
        facts = self.analyse(
            "from typing import cast as convert\n"
            "def keep(value):\n    return convert('Candidate', value)\n",
            "from typing import cast\nconvert = cast\n")
        core = next(unit for unit in facts["units"] if unit["id"] == "core")
        self.assertIn("Candidate", core["references"])
        keep = next(row for row in facts["definitions"] if "keep" in row["defines"])
        self.assertIn("Candidate", keep["references"])

    def test_assignment_alias_closure_keeps_string_type_dependency(self):
        facts = self.analyse(
            "from typing import cast as imported\nfirst = imported\nsecond = first\n"
            "def keep(value):\n    return second('Candidate', value)\n")
        core = next(unit for unit in facts["units"] if unit["id"] == "core")
        self.assertIn("Candidate", core["references"])

    def test_unrelated_string_argument_is_not_a_type_dependency(self):
        facts = self.analyse(
            "def convert(label, value):\n    return value\n"
            "def keep(value):\n    return convert('Candidate', value)\n")
        core = next(unit for unit in facts["units"] if unit["id"] == "core")
        self.assertNotIn("Candidate", core["references"])

    def test_relative_import_does_not_claim_typing_semantics(self):
        facts = self.analyse(
            "from .typing import cast as convert\n"
            "def keep(value):\n    return convert('Candidate', value)\n")
        core = next(unit for unit in facts["units"] if unit["id"] == "core")
        self.assertNotIn("Candidate", core["references"])

    def test_may_alias_is_not_a_proof_for_dispatch_rewriting(self):
        facts = self.analyse(
            "from typing import cast as convert\n"
            "def keep(ctx, value, convert):\n"
            "    convert('Candidate', value)\n"
            "    operation = value['operation']\n"
            "    if type(operation) is not str:\n        raise ValueError()\n"
            "    if operation not in OPERATIONS:\n        raise ValueError()\n"
            "    return ctx.call(convert(str, operation), {})\n"
            "OPERATIONS = {'first', 'second'}\n")
        keep = next(row for row in facts["definitions"] if "keep" in row["defines"])
        self.assertIn("Candidate", keep["references"])
        self.assertTrue(keep["opaque"])
        self.assertEqual(keep["operations"], [])


if __name__ == "__main__":
    unittest.main()
