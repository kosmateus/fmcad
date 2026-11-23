import ast
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "runtime/python/entrypoints/dependency_facts.py"
spec = importlib.util.spec_from_file_location("dependency_facts", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RegistryAliasSelection(unittest.TestCase):
    def expansions(self, source):
        source = "def a(ctx, data): return data\n\ndef b(ctx, data): return data\n" + source
        return module.registry_alias_expansions(
            {"id": "fixture", "source": source}, ast.parse(source))

    def test_selected_dispatch_preserves_original_result(self):
        source = ("def a(ctx, data): return data['value'] + 1\n"
                  "def b(ctx, data): return data['value'] - 1\n"
                  "handlers = {'keep': a, 'drop': lambda ctx, data: b(ctx, data)}\n"
                  "CAD_HANDLERS.update(handlers)\n")
        rows = module.registry_alias_expansions(
            {"id": "fixture", "source": source}, ast.parse(source))
        self.assertEqual(len(rows), 1)
        row = rows[0]
        replacement = "{" + ", ".join(
            entry["source"] for entry in row["entries"]
            if entry["operation"] == "keep") + "}"
        encoded = source.encode()
        rewritten = (encoded[:row["byteStart"]] + replacement.encode()
                     + encoded[row["byteEnd"]:]).decode()
        before, after = {"CAD_HANDLERS": {}}, {"CAD_HANDLERS": {}}
        exec(source, before)
        exec(rewritten, after)
        self.assertEqual(before["CAD_HANDLERS"]["keep"](None, {"value": 4}),
                         after["CAD_HANDLERS"]["keep"](None, {"value": 4}))
        self.assertNotIn("drop", after["CAD_HANDLERS"])

    def test_observable_or_effectful_mappings_are_not_pruned(self):
        prefix = "handlers = {'keep': a, 'drop': b}\n"
        update = "CAD_HANDLERS.update(handlers)\n"
        for source in [
                prefix + "observe(handlers)\n" + update,
                prefix + "handlers['drop'] = c\n" + update,
                prefix + update + "observe(handlers)\n",
                prefix + "alias = handlers\n" + update,
                prefix + "observe(globals())\n" + update,
                prefix + "observe(globals().get('handlers'))\n" + update,
                prefix + "observe(globals().get(dynamic))\n" + update,
                prefix + "read_namespace = globals\n" + update,
                prefix.replace("'drop': b", "'drop': missing") + update,
                "b = 42\n" + prefix + update,
                "try:\n    raise ValueError()\nexcept ValueError as b:\n    pass\n" + prefix + update,
                "def read_size(): return len(a.__globals__['handlers'])\n" + prefix + update,
                "def read_size(): return len(getattr(a, '__globals__')['handlers'])\n" + prefix + update,
                "def read_size(): return len(getattr(a, '__glo' + 'bals__')['handlers'])\n" + prefix + update,
                "def read_size(key): return len(getattr(a, key)['handlers'])\n" + prefix + update,
                "read = getattr\n"
                "def read_size(): return len(read(a, '__glo' + 'bals__')['handlers'])\n" + prefix + update,
                "read = builtins.getattr\n"
                "def read_size(): return len(read(a, '__glo' + 'bals__')['handlers'])\n" + prefix + update,
                "read = __builtins__['getattr']\n"
                "def read_size(): return len(read(a, '__glo' + 'bals__')['handlers'])\n" + prefix + update,
                "from builtins import getattr as read\n"
                "def read_size(): return len(read(a, '__glo' + 'bals__')['handlers'])\n" + prefix + update,
                "from operator import attrgetter as reader\n"
                "def read_size(): return len(reader('__glo' + 'bals__')(a)['handlers'])\n" + prefix + update,
                "def observe(ctx): return ctx.observe_namespace(a)\n" + prefix + update,
                "def observe(): return unknown_observer(a)\n" + prefix + update,
                "def observe(): return len(CAD_HANDLERS)\n" + prefix + update,
                "def observe(): return len(globals().get('CAD_HANDLERS'))\n" + prefix + update,
                "handlers = {'keep': a, 'drop': make_handler()}\n" + update,
                "handlers = {'keep': a, 'drop': lambda x=effect(): x}\n" + update,
                "handlers = {'keep': a, 'keep': b}\n" + update,
                prefix + "def later():\n    CAD_HANDLERS.update(handlers)\n",
        ]:
            with self.subTest(source=source):
                self.assertEqual(self.expansions(source), [])

    def test_peer_namespace_access_prevents_pruning(self):
        source = ("def a(ctx, data): return data\n"
                  "def b(ctx, data): return data\n"
                  "handlers = {'keep': a, 'drop': b}\nCAD_HANDLERS.update(handlers)\n")
        for peer in ["observe(handlers)", "observe(globals())"]:
            self.assertEqual(module.registry_alias_expansions(
                {"id": "fixture", "source": source}, ast.parse(source),
                [ast.parse(peer)]), [])

    def test_literal_lookup_of_another_global_does_not_escape_mapping(self):
        source = ("def a(ctx, data): return data\n"
                  "def b(ctx, data): return data\n"
                  "handlers = {'keep': a, 'drop': b}\n"
                  "CAD_HANDLERS.update(handlers)\n")
        self.assertEqual(len(module.registry_alias_expansions(
            {"id": "fixture", "source": source}, ast.parse(source),
            [ast.parse("request = globals().get('_FMCAD_REQUEST')")])), 1)

    def test_actual_parser_keeps_unknown_external_observers_conservative(self):
        for body in [
                "for key in ('name', 'value'):\n        getattr(entity, key)",
                "names = ('name', 'value')\n"
                "    return [getattr(entity, key if flag else 'other') for key in names]",
                "return ctx.observe_namespace(a)",
        ]:
            source = ("def a(ctx, data):\n    " + body + "\n"
                      "def b(ctx, data): return data\n"
                      "handlers = {'keep': a, 'drop': b}\n"
                      "CAD_HANDLERS.update(handlers)\n")
            with self.subTest(body=body):
                report = module.analyse({
                    "source": "def run(context):\n    pass\n",
                    "generated": True, "specialize": True,
                    "units": [{"id": "core", "filename": "<observer-fixture>",
                               "source": source, "dependencies": []}],
                })
                self.assertFalse(report["unsupported"])
                self.assertEqual(report["facts"]["registryExpansions"], [])

    def test_imported_factory_cannot_change_observed_registry_size(self):
        source = (
            "from operator import attrgetter as reader\n"
            "def a(ctx, data):\n"
            "    return len(reader('__glo' + 'bals__')(a)['handlers'])\n"
            "def b(ctx, data): return 0\n"
            "handlers = {'keep': a, 'drop': b}\n"
            "CAD_HANDLERS.update(handlers)\n"
        )
        report = module.analyse({
            "source": "def run(context):\n    pass\n",
            "generated": True, "specialize": True,
            "units": [{"id": "core", "filename": "<factory-observer>",
                       "source": source, "dependencies": []}],
        })
        self.assertFalse(report["unsupported"])
        self.assertEqual(report["facts"]["registryExpansions"], [])
        namespace = {"CAD_HANDLERS": {}}
        exec(source, namespace)
        self.assertEqual(namespace["a"](None, {}), 2)


if __name__ == "__main__":
    unittest.main()
