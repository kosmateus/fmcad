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


if __name__ == "__main__":
    unittest.main()
