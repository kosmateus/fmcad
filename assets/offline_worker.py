"""Internal local Python callable worker, launched only by offline_execution."""
import sys
from pathlib import Path
assets = str(Path(__file__).resolve().parent)
sys.path.pop(0)
import inspect  # Prevent assets/inspect.py shadowing the standard library.
import importlib
import json
sys.path.append(assets)

if __name__ == '__main__':
    raw = sys.stdin.buffer.read(128 * 1024 * 1024 + 1)
    if len(raw) > 128 * 1024 * 1024:
        raise ValueError('Offline worker input exceeds limit')
    request = json.loads(raw)
    result = getattr(importlib.import_module(request['module']), request['function'])(
        *request['args'], **request['kwargs'])
    print(json.dumps(result, allow_nan=False))
