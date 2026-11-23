"""Behavioral parser contract for the concrete motion dependency blocker."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "runtime/python/entrypoints/dependency_facts.py"
spec = importlib.util.spec_from_file_location("dependency_facts", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ValidatedDispatchDomain(unittest.TestCase):
    def handler_facts(self, guard, intervening="", suffix="", dispatch=None,
                      parameters="", imports=""):
        source = (
            imports + f"def checked(ctx, data{parameters}):\n"
            "    spec = data['measurement']\n"
            "    operation = spec['operation']\n"
            "    if type(operation) is not str:\n"
            "        raise ValueError('operation must be an exact string')\n"
            + guard
            + intervening
            + (dispatch or "    return ctx.call(operation, spec['data'])\n")
            + "_OPERATIONS = {'measure.' + mode for mode in ('distance', 'angle')}\n"
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
            "    if operation not in _OPERATIONS:\n"
            "        raise ValueError('unsupported operation')\n")
        self.assertFalse(facts["opaque"])
        self.assertEqual(set(facts["operations"]),
                         {"measure.distance", "measure.angle"})

    def test_absent_or_invalidated_validation_stays_opaque(self):
        guard = ("    if operation not in _OPERATIONS:\n"
                 "        raise ValueError('unsupported operation')\n")
        for args in [
                ("",),
                (guard, "    operation = supplied\n"),
                (guard, "    change(spec)\n"),
                (guard, "", "_OPERATIONS.add(supplied)\n"),
                (guard, "", "escaped = _OPERATIONS\n"),
                (guard, "", "observer = globals().get('_OPERATIONS')\n"),
                (guard, "", "read = getattr\n"),
                (guard, "", "from operator import attrgetter as reader\n"
                 "reader('__glo' + 'bals__')(checked)['_OPERATIONS'].add('drop')\n"),
                ("    if flag:\n"
                 "        if operation not in _OPERATIONS:\n"
                 "            raise ValueError('unsupported operation')\n",),
        ]:
            with self.subTest(args=args):
                self.assertTrue(self.handler_facts(*args)["opaque"])

    def test_dispatch_in_rebinding_loop_cannot_reuse_outer_guard(self):
        guard = ("    if operation not in _OPERATIONS:\n"
                 "        raise ValueError('unsupported operation')\n")
        for dispatch in [
                "    for operation in (other,):\n"
                "        return ctx.call(operation, spec['data'])\n",
                "    return [ctx.call(operation, spec['data']) for operation in (other,)]\n",
                "    return lambda operation: ctx.call(operation, spec['data'])\n",
                "    return ctx.call(spec['operation'], spec['data'])\n",
        ]:
            with self.subTest(dispatch=dispatch):
                facts = self.handler_facts(guard, dispatch=dispatch)
                self.assertTrue(facts["opaque"])

    def test_cast_call_requires_the_import_binding_not_a_shadowing_parameter(self):
        guard = ("    if operation not in _OPERATIONS:\n"
                 "        raise ValueError('unsupported operation')\n")
        for parameters, opaque in [("", False), (", cast", True)]:
            with self.subTest(parameters=parameters):
                facts = self.handler_facts(
                    guard, imports="from typing import cast\n", parameters=parameters,
                    dispatch="    return ctx.call(cast(str, operation), spec['data'])\n")
                self.assertEqual(facts["opaque"], opaque)

    def test_relative_import_cannot_claim_typing_cast_semantics(self):
        guard = ("    if operation not in _OPERATIONS:\n"
                 "        raise ValueError('unsupported operation')\n")
        facts = self.handler_facts(
            guard, imports="from .typing import cast\n",
            dispatch="    return ctx.call(cast(str, operation), spec['data'])\n")
        self.assertTrue(facts["opaque"])


if __name__ == "__main__":
    unittest.main()
