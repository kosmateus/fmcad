"""Use the canonical read-only reader for normal atomic_status calls too.

The original transaction function/source stays intact and handles every other
operation unchanged. This unit is not included in the scoped observer artifact.
"""

from typing import Callable as _AtomicStatusCallable
from typing import cast as _atomic_dispatch_cast

_atomic_status_previous_transaction = _atomic_dispatch_cast(
    "_AtomicStatusCallable[[adsk.core.Application, _AtomicArgs], JsonRecord]", _atomic_transaction)


def _atomic_status_dispatch(app: "adsk.core.Application", args: "_AtomicArgs") -> "JsonRecord":
    if args.get('operation') == 'atomic_status':
        status_args = _atomic_dispatch_cast('AtomicStatusObject', args)
        result = atomic_status_readonly(_atomic_dispatch_cast(AtomicStatusApplication, app), status_args)
        return _atomic_dispatch_cast('JsonRecord', result)
    return _atomic_status_previous_transaction(app, args)


_atomic_transaction = _atomic_status_dispatch
