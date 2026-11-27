"""SDK-free module integration against the original AdmissionStore and SQLite.

Usage: python -B tests/fixtures/dead-registered-generation.py <native-source>
The external native source is required; this is not live Fusion evidence.
"""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(sys.argv.pop(1)).resolve(strict=True)))
from lib.request_admission import AdmissionError, AdmissionStore

module_file = Path(__file__).resolve().parents[2] / "scripts/dead_registered_handoff.py"
spec = importlib.util.spec_from_file_location("dead_registered_handoff", module_file)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
encode = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))


class DeadRegisteredGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "existing.sqlite3"
        self.generation = {"instance": "registered", "epoch": "current"}
        self.next = {"instance": "fresh", "epoch": "successor"}
        with AdmissionStore(self.database, **self.generation) as store:
            store._db.executescript("""
                CREATE TABLE physical_runtime_binding(singleton INTEGER,binding TEXT);
                CREATE TABLE physical_owners(generation TEXT,binding TEXT);
                CREATE TABLE physical_turns(state TEXT,binding TEXT);
                CREATE TABLE physical_handoffs(id TEXT PRIMARY KEY,result TEXT);
            """)
        info = self.database.stat()
        self.binding = {
            "protocol": "fmcad-provision-fence-v1",
            "database": {"path": str(self.database), "device": info.st_dev, "inode": info.st_ino},
            "generation": self.generation,
            "physicalRuntime": {"pid": 17616, "birth": "134402607350031858",
                                "source": "a" * 40, "build": "b" * 64, "version": "fixture"},
            "endpointURL": "http://fixture.invalid/mcp",
        }
        self.binding_raw = encode(self.binding)
        self.request = {"handoffId": "new-request-only", "generation": self.generation,
                        "nextGeneration": self.next}
        self.execute("INSERT INTO physical_runtime_binding VALUES(1,?)", (self.binding_raw,))
        self.execute("INSERT INTO admissions VALUES(?,?,'terminal',NULL,?)",
                     ("historical", "immutable-original", '{"state":"UNKNOWN"}'))
        self.fences = 0

    def execute(self, sql, parameters=()):
        with sqlite3.connect(self.database) as db:
            return db.execute(sql, parameters).fetchall()

    def snapshot(self):
        return {name: self.execute("SELECT * FROM " + name) for name in (
            "generation", "generation_history", "physical_handoffs",
            "physical_runtime_binding", "physical_owners", "admissions", "physical_turns")}

    def fence(self):
        self.fences += 1

    def advance(self, fence=None):
        return api.advance_dead_registered_generation(
            str(self.database), self.binding_raw, self.request, fence or self.fence)

    def denied_without_cas(self, fence=None):
        before = self.snapshot()
        with self.assertRaises((AdmissionError, ValueError)):
            self.advance(fence)
        self.assertEqual(self.snapshot(), before)

    def test_actual_registered_dead_cas_preserves_binding_history_and_unknown(self):
        before = self.snapshot()
        file_object = (self.database.stat().st_dev, self.database.stat().st_ino)
        result = self.advance()
        self.assertEqual(result, {**self.request, "state": "committed"})
        self.assertEqual(self.execute("SELECT instance,epoch FROM generation"),
                         [(self.next["instance"], self.next["epoch"])])
        self.assertEqual(self.execute("SELECT result FROM physical_handoffs"),
                         [(encode(result),)])
        self.assertEqual(self.snapshot()["admissions"], before["admissions"])
        self.assertEqual(self.snapshot()["physical_runtime_binding"],
                         before["physical_runtime_binding"])
        self.assertEqual((self.database.stat().st_dev, self.database.stat().st_ino), file_object)
        self.assertEqual(self.fences, 2)

    def test_alive_or_lost_lease_or_changed_native_identity_refuses_cas(self):
        for reason in ("original process alive", "writer lease lost", "native database object changed"):
            with self.subTest(reason=reason):
                def refused():
                    raise ValueError(reason)
                self.denied_without_cas(refused)

    def test_active_admission_refuses_cas(self):
        self.execute("INSERT INTO admissions VALUES(?,?,'accepted',NULL,NULL)", ("active", "fixture"))
        self.denied_without_cas()

    def test_claimed_admission_refuses_cas(self):
        self.execute("INSERT INTO admissions VALUES(?,?,'claimed',?,NULL)", ("claimed", "fixture", "claim"))
        self.denied_without_cas()

    def test_current_owner_refuses_cas(self):
        self.execute("INSERT INTO physical_owners VALUES(?,?)", (encode(self.generation), "fixture"))
        self.denied_without_cas()

    def test_successor_owner_refuses_cas(self):
        self.execute("INSERT INTO physical_owners VALUES(?,?)", (encode(self.next), "fixture"))
        self.denied_without_cas()

    def test_unreleased_turn_refuses_cas(self):
        self.execute("INSERT INTO physical_turns VALUES('claimed','fixture')")
        self.denied_without_cas()

    def test_changed_registration_refuses_cas(self):
        changed = {**self.binding, "physicalRuntime": {**self.binding["physicalRuntime"], "birth": "other"}}
        self.execute("UPDATE physical_runtime_binding SET binding=?", (encode(changed),))
        self.denied_without_cas()

    def test_stale_generation_refuses_cas(self):
        self.execute("UPDATE generation SET epoch='another'")
        self.denied_without_cas()

    def test_original_handoff_id_cannot_be_replayed(self):
        self.execute("INSERT INTO physical_handoffs VALUES(?,?)", (self.request["handoffId"], "original"))
        self.denied_without_cas()

    def test_generation_cannot_be_reused(self):
        self.execute("INSERT INTO generation_history VALUES(?,?)", tuple(self.next.values()))
        self.denied_without_cas()

    def test_guard_runs_inside_real_sqlite_writer_transaction(self):
        locked = []
        def guarded():
            self.fences += 1
            if self.fences == 2:
                with sqlite3.connect(self.database, timeout=0) as competing:
                    try:
                        competing.execute("UPDATE physical_runtime_binding SET binding='foreign'")
                    except sqlite3.OperationalError as error:
                        locked.append(str(error))
                    else:
                        self.fail("Competing writer entered the guarded CAS transaction")
        self.advance(guarded)
        self.assertEqual(len(locked), 1)
        self.assertIn("locked", locked[0])


unittest.main()
