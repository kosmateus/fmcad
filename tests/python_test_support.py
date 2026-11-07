"""Shared source prelude for offline fixtures that execute retained CAD assets."""
from pathlib import Path


def load_canonical_values(namespace, root):
    path = Path(root) / 'runtime/python/fmcad/domain/values.py'
    exec(compile(path.read_text(), str(path), 'exec'), namespace)


def load_legacy_core(namespace, root):
    """Load core.py with the canonical value bindings used by the prepared bundle."""
    load_canonical_values(namespace, root)
    path = Path(root) / 'assets/cad/core.py'
    exec(compile(path.read_text(), str(path), 'exec'), namespace)
