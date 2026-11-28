"""Private SDK-free handoff for an exact, already-dead registered runtime.

The caller must hold its real lifecycle writer lease and supply a native fence
that proves process death, source/provision pins and database file identity.
No old UNKNOWN is settled. All writes use AdmissionStore's existing atomic CAS.
"""

import json
from pathlib import Path
from typing import Callable

def advance_dead_registered_generation(
    database: str,
    registered_json: str,
    request: dict,
    assert_native_fence: Callable[[], None],
) -> dict:
    """Check all mutable facts in the transaction that performs the real CAS."""
    # Native callers import this only after their pinned source/ACL fence.
    from lib.request_admission import AdmissionError, AdmissionStore

    if not callable(assert_native_fence):
        raise AdmissionError("A held native lifecycle fence is required")
    registered = json.loads(registered_json)
    if (
        type(registered) is not dict
        or set(registered) != {
            "protocol", "database", "generation", "physicalRuntime", "endpointURL"
        }
        or registered["protocol"] != "fmcad-provision-fence-v1"
        or type(request) is not dict
        or set(request) != {"handoffId", "generation", "nextGeneration"}
        or request["generation"] != registered["generation"]
        or not isinstance(request["handoffId"], str)
        or not request["handoffId"]
    ):
        raise AdmissionError("Exact registered generation and new handoff required")
    for generation in (request["generation"], request["nextGeneration"]):
        if (
            type(generation) is not dict
            or set(generation) != {"instance", "epoch"}
            or any(not isinstance(v, str) or not v for v in generation.values())
        ):
            raise AdmissionError("Exact generation pair required")
    runtime = registered["physicalRuntime"]
    if (
        type(runtime) is not dict
        or set(runtime) != {"pid", "birth", "source", "build", "version"}
        or type(runtime["pid"]) is not int
        or not 0 < runtime["pid"] <= 0xffffffff
        or any(not isinstance(runtime[k], str) or not runtime[k]
               for k in ("birth", "source", "build", "version"))
        or request["nextGeneration"] == request["generation"]
    ):
        raise AdmissionError("Exact registered runtime and fresh generation required")
    filename = Path(database)
    if not filename.is_absolute() or str(filename.resolve(strict=True)) != database:
        raise AdmissionError("Canonical existing database required")

    class DeadRegisteredStore(AdmissionStore):
        def assert_provision_lifecycle_allowed(self):
            super().assert_provision_lifecycle_allowed()
            # AdmissionStore invokes this hook inside BEGIN IMMEDIATE, before
            # its CAS/history writes. A separate preflight would race producers.
            assert_native_fence()
            self.assert_current_generation()
            info = filename.stat()
            if registered["database"] != {
                "path": str(filename), "device": info.st_dev, "inode": info.st_ino
            }:
                raise AdmissionError("Original database file object differs")
            row = self._db.execute(
                "SELECT binding FROM physical_runtime_binding WHERE singleton=1"
            ).fetchone()
            if row is None or row[0] != registered_json:
                raise AdmissionError("Exact registered physical runtime changed")
            if self._db.execute(
                "SELECT 1 FROM physical_owners WHERE generation IN (?,?) LIMIT 1",
                tuple(json.dumps(g, sort_keys=True, separators=(",", ":"))
                      for g in (request["generation"], request["nextGeneration"])),
            ).fetchone():
                raise AdmissionError("Physical owner prevents dead-runtime handoff")
            if self._db.execute(
                "SELECT 1 FROM admissions WHERE state IN ('accepted','claimed') LIMIT 1"
            ).fetchone():
                raise AdmissionError("Active admission prevents dead-runtime handoff")
            if self._db.execute(
                "SELECT 1 FROM physical_turns WHERE state!='released' LIMIT 1"
            ).fetchone():
                raise AdmissionError("Unreleased turn prevents dead-runtime handoff")
            if self._db.execute(
                "SELECT 1 FROM physical_handoffs WHERE id=?", (request["handoffId"],)
            ).fetchone():
                raise AdmissionError("Existing handoff ID must be queried, never replayed")

    assert_native_fence()
    with DeadRegisteredStore(database, create=False, **request["generation"]) as store:
        return store.advance_generation(
            **request["nextGeneration"], handoff_id=request["handoffId"]
        )
