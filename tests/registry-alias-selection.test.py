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

    def test_reflection_key_domain_comes_from_literal_loop_not_annotation(self):
        source = "for key in ('name', 'value'):\n    getattr(entity, key)\n"
        tree = ast.parse(source)
        nodes = list(ast.walk(tree))
        parents = {child: parent for parent in nodes for child in ast.iter_child_nodes(parent)}
        expression = next(node.args[1] for node in nodes
                          if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                          and node.func.id == 'getattr')
        self.assertEqual(module.reflection_attribute_keys(expression, parents, nodes),
                         {'name', 'value'})
        mutated = ast.parse("for key in ('name',):\n    key = supplied\n    getattr(entity, key)\n")
        nodes = list(ast.walk(mutated))
        parents = {child: parent for parent in nodes for child in ast.iter_child_nodes(parent)}
        expression = next(node.args[1] for node in nodes if isinstance(node, ast.Call))
        with self.assertRaises(module.Unknown):
            module.reflection_attribute_keys(expression, parents, nodes)

    def test_immutable_local_key_tuple_and_conditional_domains(self):
        source = ("def snapshot(entity):\n"
                  "    names = ('name', 'value')\n"
                  "    return [getattr(entity, key if flag else 'other') for key in names]\n")
        tree = ast.parse(source)
        nodes = list(ast.walk(tree))
        parents = {child: parent for parent in nodes for child in ast.iter_child_nodes(parent)}
        expression = next(node.args[1] for node in nodes if isinstance(node, ast.Call))
        self.assertEqual(module.reflection_attribute_keys(expression, parents, nodes),
                         {'name', 'value', 'other'})
        tree = ast.parse(source.replace("    return", "    names = supplied\n    return"))
        nodes = list(ast.walk(tree))
        parents = {child: parent for parent in nodes for child in ast.iter_child_nodes(parent)}
        expression = next(node.args[1] for node in nodes if isinstance(node, ast.Call))
        with self.assertRaises(module.Unknown):
            module.reflection_attribute_keys(expression, parents, nodes)


if __name__ == "__main__":
    unittest.main()
