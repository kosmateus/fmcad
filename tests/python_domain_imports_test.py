import hashlib
import importlib
import importlib.util
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections import UserDict


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime" / "python"
DOMAIN = RUNTIME / "fmcad" / "domain"
LOWERER_PATH = RUNTIME / "entrypoints" / "lower_domain_imports.py"
LINTER_CONFIG = ROOT / "tests" / "python-importlinter.ini"


def load_lowerer():
    spec = importlib.util.spec_from_file_location("lower_domain_imports", LOWERER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load domain import lowerer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LOWERER = load_lowerer()


def domain_unit(module, source=None):
    filename = f"runtime/python/fmcad/domain/{module}.py"
    return {
        "id": module,
        "filename": filename,
        "source": (
            (ROOT / filename).read_text(encoding="utf-8")
            if source is None
            else source
        ),
    }


def flattened_domain_module(module_name):
    values = domain_unit("values")
    module = domain_unit(module_name)
    units = LOWERER.lower_domain_imports([values, module])
    namespace = {"__name__": f"fmcad.domain.{module_name}"}
    for unit in units:
        exec(compile(unit["source"], unit["filename"], "exec"), namespace)
    return namespace


def with_pythonpath(env, path):
    env["PYTHONPATH"] = os.pathsep.join(
        value for value in (str(path), env.get("PYTHONPATH", "")) if value
    )
    return env


class DomainImportLoweringTests(unittest.TestCase):
    def test_lowers_only_proven_imports_and_preserves_alias_line_and_hash(self):
        original = (
            'marker = "source\\n"\n'
            "from fmcad.domain.values import Marker\n"
            "from fmcad.domain.values import Marker as _marker\n"
            "observed = (_marker, Marker)"
        )
        lowered = LOWERER.lower_domain_imports(
            [
                domain_unit("values", "Marker = object()\n"),
                domain_unit("animation2", original),
            ]
        )
        source = lowered[1]["source"]
        lines = source.splitlines()

        self.assertEqual(lines[1], "pass")
        self.assertEqual(lines[2], "_marker = Marker")
        self.assertEqual(lines[3], "observed = (_marker, Marker)")
        self.assertEqual(len(lines), 5)
        self.assertEqual(
            lines[-1],
            "# fmcad-domain-imports-v1; original-sha256="
            + hashlib.sha256(original.encode("utf-8")).hexdigest(),
        )

        namespace = {}
        for unit in lowered:
            exec(compile(unit["source"], unit["filename"], "exec"), namespace)
        self.assertIs(namespace["observed"][0], namespace["observed"][1])

    def test_external_imports_remain_byte_for_byte_unchanged(self):
        source = "from math import sqrt\nresult = sqrt(9)\n"
        result = LOWERER.lower_domain_imports(
            [domain_unit("animation2", source)]
        )
        self.assertEqual(result[0]["source"], source)

    def test_rejects_unsupported_internal_import_shapes(self):
        cases = (
            "import fmcad.domain.values\n",
            "from fmcad.domain import values\n",
            "from fmcad.domain.values import *\n",
            "def load():\n    from fmcad.domain.values import Marker\n",
            "from .values import Marker\n",
            "import importlib\nimportlib.import_module('fmcad.domain.values')\n",
        )
        for source in cases:
            with self.subTest(source=source):
                with self.assertRaises(LOWERER.DomainImportError):
                    LOWERER.lower_domain_imports(
                        [
                            domain_unit("values", "Marker = object()\n"),
                            domain_unit("animation2", source),
                        ]
                    )

    def test_rejects_missing_late_unproven_and_rebound_targets(self):
        with self.assertRaisesRegex(LOWERER.DomainImportError, "absent"):
            LOWERER.lower_domain_imports(
                [domain_unit("animation2", "from fmcad.domain.values import Marker\n")]
            )

        with self.assertRaisesRegex(LOWERER.DomainImportError, "not earlier"):
            LOWERER.lower_domain_imports(
                [
                    domain_unit("animation2", "from fmcad.domain.values import Marker\n"),
                    domain_unit("values", "Marker = object()\n"),
                ]
            )

        with self.assertRaisesRegex(LOWERER.DomainImportError, "not a proven"):
            LOWERER.lower_domain_imports(
                [
                    domain_unit("values", "if condition:\n    Marker = object()\n"),
                    domain_unit("animation2", "from fmcad.domain.values import Marker\n"),
                ]
            )

        with self.assertRaisesRegex(LOWERER.DomainImportError, "overwritten"):
            LOWERER.lower_domain_imports(
                [
                    domain_unit("values", "Marker = object()\n"),
                    domain_unit(
                        "animation2",
                        "Marker = object()\n"
                        "from fmcad.domain.values import Marker\n",
                    ),
                ]
            )


class StandaloneDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(RUNTIME))

    @classmethod
    def tearDownClass(cls):
        if sys.path[0] == str(RUNTIME):
            sys.path.pop(0)

    def test_every_owned_domain_module_imports_as_a_real_package(self):
        modules = sorted(path.stem for path in DOMAIN.glob("*.py") if path.stem != "assembly")
        imported = [importlib.import_module(f"fmcad.domain.{name}") for name in modules]
        self.assertEqual(len(imported), len(modules))
        self.assertNotIn("_CadAttributes", importlib.import_module("fmcad.domain.values").__dict__)
        self.assertNotIn("_DesignCaster", importlib.import_module("fmcad.domain.values").__dict__)

    def test_domain_pure_functions_match_the_flattened_runtime(self):
        cases = (
            ("animation2", "_anim2_number", (2, "number"), 2.0),
            ("checking", "_compare_scalar", (2.0, {"equals": 2.0}), None),
            ("containment", "_containment_vnorm", ([3.0, 4.0, 0.0],), 5.0),
            ("data_import", "_di_json_object", ({"name": "part"}, "metadata"), {"name": "part"}),
            ("dfm", "_dfm_deg", (math.pi,), 180.0),
            (
                "document",
                "document_copy_request",
                ({"name": "Part", "project": "project-id", "folder": ""},),
                {
                    "name": "Part",
                    "project": "project-id",
                    "folder": "",
                    "description": "",
                    "tag": "",
                },
            ),
            ("externalization", "_external_next_saved_name", ("Part v2", 2), "Part v3"),
            ("interference", "_ref_key", ({},), "{}"),
            ("io", "_io_camera_vector", ([3, 4, 0], "vector", 3), [3.0, 4.0, 0.0]),
            ("measure", "_measure_value", (2, "length", {"units": "mm"}), {"value": 20.0, "units": "mm", "dimension": "length"}),
            ("regional_geometry", "regional_geometry_nonnegative", (2,), 2.0),
        )
        for module_name, function_name, args, expected in cases:
            with self.subTest(module=module_name, function=function_name):
                standalone = getattr(
                    importlib.import_module(f"fmcad.domain.{module_name}"), function_name
                )(*args)
                flattened = flattened_domain_module(module_name)[function_name](*args)
                if expected is None:
                    self.assertEqual(standalone, flattened)
                    self.assertTrue(standalone["passed"])
                else:
                    self.assertEqual(standalone, expected)
                    self.assertEqual(standalone, flattened)

    def test_shared_validation_helper_preserves_mapping_semantics(self):
        values = importlib.import_module("fmcad.domain.values")
        self.assertIsNone(values._cad_fields(UserDict({"confirm": True}), ("confirm",)))
        with self.assertRaisesRegex(ValueError, "unsupported inputs"):
            values._cad_fields(UserDict({"unexpected": True}))

    def test_import_linter_accepts_production_graph(self):
        env = os.environ.copy()
        with_pythonpath(env, RUNTIME)
        result = subprocess.run(
            ["lint-imports", "--config", str(LINTER_CONFIG)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_import_linter_rejects_a_bad_layer_and_a_domain_cycle(self):
        config = LINTER_CONFIG.read_text(encoding="utf-8")
        for fixture, files, expected in (
            (
                "bad-layer",
                {
                    "fmcad/domain/bad.py": "from fmcad.adapters.good import value\n",
                    "fmcad/adapters/good.py": "value = 1\n",
                },
                "Production package layers",
            ),
            (
                "bad-cycle",
                {
                    "fmcad/domain/first.py": "from fmcad.domain.second import value\n",
                    "fmcad/domain/second.py": "from fmcad.domain.first import value\n",
                },
                "Domain sibling modules remain acyclic",
            ),
        ):
            with self.subTest(fixture=fixture), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for package in ("domain", "ports", "application", "adapters"):
                    package_path = root / "fmcad" / package
                    package_path.mkdir(parents=True, exist_ok=True)
                    (package_path / "__init__.py").write_text("", encoding="utf-8")
                for relative, source in files.items():
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(source, encoding="utf-8")
                config_path = root / "python-importlinter.ini"
                config_path.write_text(config, encoding="utf-8")
                env = os.environ.copy()
                with_pythonpath(env, root)
                result = subprocess.run(
                    ["lint-imports", "--config", str(config_path)],
                    cwd=root,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(expected, result.stdout + result.stderr)

    def test_pydeps_writes_a_real_domain_import_graph(self):
        pydeps = shutil.which("pydeps")
        self.assertIsNotNone(pydeps, "Install tests/python-domain-import-requirements.txt")
        env = os.environ.copy()
        with_pythonpath(env, RUNTIME)
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "python-domain-imports.dot"
            result = subprocess.run(
                [
                    pydeps,
                    "--show-dot",
                    "--dot-output",
                    str(report),
                    "--max-bacon=0",
                    "--no-show",
                    "--no-output",
                    "fmcad.domain",
                ],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            graph = report.read_text(encoding="utf-8")
            self.assertIn("domain_animation2", graph)
            self.assertIn("fmcad_domain_values", graph)
            self.assertIn("->", graph)


if __name__ == "__main__":
    unittest.main()
