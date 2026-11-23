"""Behavioral parser contract for the concrete motion dependency blocker."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "runtime/python/entrypoints/dependency_facts.py"
spec = importlib.util.spec_from_file_location("dependency_facts", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ValidatedDispatchDomain(unittest.TestCase):
    def handler_facts(self, guard, intervening="", suffix=""):
        source = (
            "def checked(ctx, data):\n"
            "    spec = data['measurement']\n"
            + guard
            + intervening
            + "    return ctx.call(spec['operation'], spec['data'])\n"
            "_OPERATIONS = {'measure.' + mode for mode in ('distance', 'angle')}\n"
            + suffix
        )
        result = module.analyse({
            "source": "def run(context):\n    pass\n",
            "generated": True,
            "units": [{
                "id": "core", "filename": "<validated-domain>",
                "source": source, "dependencies": [],
            }],
        })
        return result["facts"]["symbols"]["checked"][0]

    def test_dominating_finite_validation_closes_dynamic_dispatch(self):
        facts = self.handler_facts(
            "    if spec['operation'] not in _OPERATIONS:\n"
            "        raise ValueError('unsupported operation')\n")
        self.assertFalse(facts["opaque"])
        self.assertEqual(set(facts["operations"]),
                         {"measure.distance", "measure.angle"})

    def test_absent_or_invalidated_validation_stays_opaque(self):
        guard = ("    if spec['operation'] not in _OPERATIONS:\n"
                 "        raise ValueError('unsupported operation')\n")
        for args in [
                ("",),
                (guard, "    spec['operation'] = supplied\n"),
                (guard, "    change(spec)\n"),
                (guard, "", "_OPERATIONS.add(supplied)\n"),
                (guard, "", "escaped = _OPERATIONS\n"),
                (guard, "", "observer = globals().get('_OPERATIONS')\n"),
                ("    if flag:\n"
                 "        if spec['operation'] not in _OPERATIONS:\n"
                 "            raise ValueError('unsupported operation')\n",),
        ]:
            with self.subTest(args=args):
                self.assertTrue(self.handler_facts(*args)["opaque"])


if __name__ == "__main__":
    unittest.main()
