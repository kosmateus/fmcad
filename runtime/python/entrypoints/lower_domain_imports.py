"""Conservatively lower canonical domain imports for the flattened runtime."""
import ast
import hashlib
import json
import re
import symtable
import sys


DOMAIN_PREFIX = "runtime/python/fmcad/domain/"
DOMAIN_IMPORT_LOWERING_VERSION = 1
STABLE_DOMAIN_IMPORTS = {
    ("values", "_cad_fields"): "__fmcad_domain_values__cad_fields",
}


class DomainImportError(ValueError):
    pass


def _domain_module(filename):
    if not filename.startswith(DOMAIN_PREFIX) or not filename.endswith(".py"):
        return None
    module = filename[len(DOMAIN_PREFIX) : -3]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", module):
        return None
    return module


def _target_names(target):
    if isinstance(target, ast.Name):
        yield target.id
    elif isinstance(target, (ast.Tuple, ast.List)):
        for element in target.elts:
            yield from _target_names(element)
    elif isinstance(target, ast.Starred):
        yield from _target_names(target.value)


def _statement_bindings(statement, conditional=False):
    """Yield module bindings, marking bindings under control flow uncertain."""
    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        yield statement.name, conditional
        return
    if isinstance(statement, ast.Import):
        for imported in statement.names:
            yield imported.asname or imported.name.split(".", 1)[0], conditional
        return
    if isinstance(statement, ast.ImportFrom):
        for imported in statement.names:
            if imported.name != "*":
                yield imported.asname or imported.name, conditional
        return
    if isinstance(statement, ast.Assign):
        for target in statement.targets:
            for name in _target_names(target):
                yield name, conditional
        return
    if isinstance(statement, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        for name in _target_names(statement.target):
            yield name, conditional
        return
    if isinstance(statement, ast.Delete):
        for target in statement.targets:
            for name in _target_names(target):
                yield name, True
        return

    nested = []
    for attribute in ("body", "orelse", "finalbody"):
        nested.extend(getattr(statement, attribute, ()))
    for handler in getattr(statement, "handlers", ()):
        if handler.name:
            yield handler.name, True
        nested.extend(handler.body)
    for item in nested:
        yield from _statement_bindings(item, True)
    if isinstance(statement, (ast.For, ast.AsyncFor)):
        for name in _target_names(statement.target):
            yield name, True
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        for item in statement.items:
            if item.optional_vars:
                for name in _target_names(item.optional_vars):
                    yield name, True
    if isinstance(statement, ast.Match):
        for case in statement.cases:
            for item in case.body:
                yield from _statement_bindings(item, True)


def _direct_bindings(tree):
    result = set()
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            result.add(statement.name)
        elif isinstance(statement, (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign)):
            result.update(name for name, conditional in _statement_bindings(statement) if not conditional)
    return result


def _internal_import(node, filename, top_level_imports):
    if isinstance(node, ast.Import):
        for imported in node.names:
            if imported.name == "fmcad.domain" or imported.name.startswith("fmcad.domain."):
                raise DomainImportError(
                    f"Unsupported internal import in {filename}:{node.lineno}: "
                    "use `from fmcad.domain.<module> import <symbol> [as alias]`"
                )
        return None

    if not isinstance(node, ast.ImportFrom):
        return None
    module = node.module or ""
    internal = module == "fmcad.domain" or module.startswith("fmcad.domain.")
    if node.level:
        if _domain_module(filename) is not None:
            raise DomainImportError(
                f"Unsupported relative domain import in {filename}:{node.lineno}"
            )
        return None
    if not internal:
        return None
    if id(node) not in top_level_imports:
        raise DomainImportError(
            f"Internal domain import must be top-level in {filename}:{node.lineno}"
        )
    match = re.fullmatch(r"fmcad\.domain\.([A-Za-z_][A-Za-z0-9_]*)", module)
    if match is None or len(node.names) != 1 or node.names[0].name == "*":
        raise DomainImportError(
            f"Unsupported internal domain import in {filename}:{node.lineno}: "
            "only one named symbol from one canonical module is supported"
        )
    return match.group(1), node.names[0].name, node.names[0].asname


def _reject_literal_dynamic_domain_imports(tree, filename):
    if _domain_module(filename) is None:
        return
    imported_functions = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "importlib":
            imported_functions.update(
                item.asname or item.name
                for item in node.names
                if item.name == "import_module"
            )
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        is_dynamic_import = (
            isinstance(node.func, ast.Name)
            and (node.func.id == "__import__" or node.func.id in imported_functions)
        ) or (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "import_module"
        )
        if not is_dynamic_import or not node.args:
            continue
        module = node.args[0]
        if (
            isinstance(module, ast.Constant)
            and isinstance(module.value, str)
            and (module.value == "fmcad.domain" or module.value.startswith("fmcad.domain."))
        ):
            raise DomainImportError(
                f"Unsupported dynamic internal domain import in {filename}:{node.lineno}"
            )


def lower_domain_imports(units):
    """Lower proven imports in a complete, ordered bundle inventory."""
    if not isinstance(units, list):
        raise DomainImportError("Domain import input must contain an ordered unit list")

    parsed = []
    ids = set()
    filenames = set()
    domain_units = {}
    for index, unit in enumerate(units):
        if (
            not isinstance(unit, dict)
            or not isinstance(unit.get("id"), str)
            or not unit["id"]
            or not isinstance(unit.get("filename"), str)
            or not isinstance(unit.get("source"), str)
            or unit["id"] in ids
            or unit["filename"] in filenames
        ):
            raise DomainImportError("Invalid or duplicate ordered domain import unit")
        ids.add(unit["id"])
        filenames.add(unit["filename"])
        module = _domain_module(unit["filename"])
        if module is not None:
            if module in domain_units:
                raise DomainImportError("Duplicate canonical domain module: " + module)
            domain_units[module] = index
        try:
            tree = ast.parse(unit["source"], filename=unit["filename"])
            symbols = symtable.symtable(unit["source"], unit["filename"], "exec")
        except (SyntaxError, ValueError) as error:
            raise DomainImportError(f"Invalid Python unit {unit['filename']}: {error}") from error
        top_level_imports = {
            id(statement)
            for statement in tree.body
            if isinstance(statement, (ast.Import, ast.ImportFrom))
        }
        for node in ast.walk(tree):
            _internal_import(node, unit["filename"], top_level_imports)
        _reject_literal_dynamic_domain_imports(tree, unit["filename"])
        direct = _direct_bindings(tree)
        parsed.append(
            {
                "unit": unit,
                "tree": tree,
                "symbols": symbols,
                "domain": module,
                "direct": direct,
                "imports": top_level_imports,
                "index": index,
            }
        )

    origins = {}
    exports = {}
    lowered = []
    for item in parsed:
        unit = item["unit"]
        filename = unit["filename"]
        replacements = {}
        module_exports = {}
        for statement in item["tree"].body:
            internal = _internal_import(statement, filename, item["imports"])
            if internal is not None:
                target_module, symbol, alias = internal
                target_index = domain_units.get(target_module)
                if target_index is None:
                    raise DomainImportError(
                        f"Internal domain import target is absent from the full inventory: "
                        f"{filename}:{statement.lineno}: fmcad.domain.{target_module}"
                    )
                if target_index >= item["index"]:
                    raise DomainImportError(
                        f"Internal domain import target is not earlier in bundle order: "
                        f"{filename}:{statement.lineno}: fmcad.domain.{target_module}"
                    )
                target = parsed[target_index]
                try:
                    target_symbol = target["symbols"].lookup(symbol)
                except KeyError:
                    target_symbol = None
                if (
                    symbol not in target["direct"]
                    or target_symbol is None
                    or not (target_symbol.is_assigned() or target_symbol.is_imported())
                    or symbol not in exports.get(target_module, {})
                ):
                    raise DomainImportError(
                        f"Internal domain import symbol is not a proven top-level export: "
                        f"{filename}:{statement.lineno}: fmcad.domain.{target_module}.{symbol}"
                    )
                binding = symbol
                expected_origin = exports[target_module][symbol]
                stable_binding = STABLE_DOMAIN_IMPORTS.get((target_module, symbol))
                if alias is not None and stable_binding in target["direct"]:
                    stable_origin = exports[target_module].get(stable_binding)
                    if stable_origin is None or origins.get(stable_binding) != stable_origin:
                        raise DomainImportError(
                            f"Stable internal domain import binding was overwritten or is uncertain: "
                            f"{filename}:{statement.lineno}: fmcad.domain.{target_module}.{symbol}"
                        )
                    binding = stable_binding
                    expected_origin = stable_origin
                elif origins.get(symbol) != expected_origin:
                    raise DomainImportError(
                        f"Internal domain import binding was overwritten or is uncertain: "
                        f"{filename}:{statement.lineno}: fmcad.domain.{target_module}.{symbol}"
                    )
                alias_name = alias or symbol
                if alias_name != symbol:
                    origins[alias_name] = expected_origin
                    replacement = f"{alias_name} = {binding}"
                else:
                    replacement = "pass"
                lines = unit["source"].splitlines(keepends=True)
                line = lines[statement.lineno - 1]
                if statement.end_lineno != statement.lineno or statement.col_offset != 0:
                    raise DomainImportError(
                        f"Internal domain import must occupy one unindented line: "
                        f"{filename}:{statement.lineno}"
                    )
                tail = line[statement.end_col_offset :]
                if tail.strip() and not tail.lstrip().startswith("#"):
                    raise DomainImportError(
                        f"Internal domain import must be a standalone statement: "
                        f"{filename}:{statement.lineno}"
                    )
                replacements[statement.lineno - 1] = replacement + tail
                continue

            for name, uncertain in _statement_bindings(statement):
                origins[name] = None if uncertain else (filename, name)

        module_name = item["domain"]
        if module_name is not None:
            for symbol in item["direct"]:
                if symbol in origins:
                    module_exports[symbol] = origins[symbol]
            exports[module_name] = module_exports

        source = unit["source"]
        if replacements:
            lines = source.splitlines(keepends=True)
            for line_index, replacement in replacements.items():
                lines[line_index] = replacement
            source = "".join(lines)
            if not source.endswith(("\n", "\r")):
                source += "\n"
            original_hash = hashlib.sha256(unit["source"].encode("utf-8")).hexdigest()
            source += f"# fmcad-domain-imports-v{DOMAIN_IMPORT_LOWERING_VERSION}; original-sha256={original_hash}\n"
        lowered.append({**unit, "source": source})

    return lowered


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise DomainImportError("Domain import request must be an object")
        result = {
            "version": DOMAIN_IMPORT_LOWERING_VERSION,
            "units": lower_domain_imports(request.get("units")),
        }
    except (DomainImportError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    json.dump(result, sys.stdout, ensure_ascii=True, allow_nan=False)
