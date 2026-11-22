"""OFFLINE: real pinned PR4 AdmissionStore/guards, owned SQLite only, no SDK."""
import copy
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

archive, fragment, artifacts = map(Path, sys.argv[1:4])
sys.argv = [sys.argv[0]]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == "b69446aee1152f50ed05b69dc946abb0b45b83e21a101975eb2b3d6a947ca8c8"
native_root = artifacts / "native-source"
with zipfile.ZipFile(archive) as source:
    source.extractall(native_root)
sys.path.insert(0, str(native_root / "native-pr4"))
from lib.request_admission import AdmissionStore, AdmissionError, _encode
from lib.rebaseline_fence import OperatorAuthority, begin_fence, consume_fence, query_fence, observe_process_birth
from lib import rebaseline_fence_store as native

exec(compile(fragment.read_text(), str(fragment), "exec"))


class SuccessorQuery(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=artifacts)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / "owned.sqlite"
        with AdmissionStore(self.database, instance="before", epoch="before") as store:
            store.advance_generation(instance="g0", epoch="e0", handoff_id="initial")
        self.store = AdmissionStore(self.database, instance="g0", epoch="e0", create=False)
        self.addCleanup(lambda: self.store.close())
        self.runtime = dict(
            handoffId="initial", generation=dict(instance="g0", epoch="e0"),
            physicalRuntime=dict(pid=os.getpid(), birth=observe_process_birth(os.getpid()),
                                 version="offline", source="PR4-fixture", build="fixture"),
            endpointURL="http://127.0.0.1:8765/mcp",
        )
        self.key = bytes(range(32))  # Fixture-only, never a production credential.
        self.authority = self.operator()
        self.register()
        self.posix = str(self.root / "owned-posix") if os.name != "nt" else "/offline/canonical-store"
        request = dict(requestId="root-one", handoffId="initial", expectedHead="a" * 64,
                       writerGeneration="fixture-writer", store=dict(path=self.posix, device=1, inode=2),
                       intentReferences=[dict(path="/fixture/intent.json", sha256="b" * 64)])
        pending = begin_fence(self.authority, request)
        record = dict(path=self.posix + "/runtime-rebaselines/root-one/record.json", sha256="c" * 64)
        publication = dict(
            store=self.posix, storeDevice=1, storeInode=2, expectedHead="a" * 64,
            expectedFiles={name: None for name in (
                "physical-backend-head.json", "isolated-admission-epoch.json", "instance.json",
                "queue-state.json", "queue-state.pending.json", "runtime-rebaseline-head.json")},
            activationFile=self.posix + "/runtime-rebaseline-head.json",
            activationBytes=json.dumps(dict(version=1, newHead="d" * 64, record=record)),
            record=record,
        )
        raw = json.dumps(publication)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        mac = hmac.new(self.key, b"fmcad-posix-publication-v1\0" + _encode(dict(
            binding=pending["binding"], publicationDigest=digest)).encode(), hashlib.sha256).hexdigest()
        self.original = consume_fence(self.authority, dict(
            requestId="root-one", fenceNonce=pending["binding"]["fenceNonce"],
            publicationJson=raw, attestation=dict(keyId="offline-key", mac=mac)))
        self.original_row = self.store._db.execute("SELECT * FROM provision_fences").fetchone()

    def operator(self):
        return OperatorAuthority(dict(
            kind="fmcad-rebaseline-operator", version=1, operatorId="offline",
            database=str(self.database), runtime=copy.deepcopy(self.runtime),
            publicationVerifier=dict(keyId="offline-key", keyHex=self.key.hex())))

    def register(self):
        self.store.register_physical_runtime({k: copy.deepcopy(self.runtime[k])
                                             for k in ("generation", "physicalRuntime", "endpointURL")})

    def handoff(self, index):
        descriptor = dict(kind="fmcad-physical-grant", version=1, **copy.deepcopy(self.runtime),
                          brokerOwner=dict(pid=os.getpid(), birth="fixture", nonce="fixture-owner",
                                           clientId="offline", queueDirectory=self.posix))
        approval = native.activation_for(self.original["receiptJson"]) if index == 1 else None
        self.store.bind_physical_owner(descriptor, activation=approval)
        self.store.advance_generation(instance="g" + str(index), epoch="e" + str(index),
                                      handoff_id="handoff-" + str(index))
        self.store.close()
        self.runtime["generation"] = dict(instance="g" + str(index), epoch="e" + str(index))
        self.runtime["handoffId"] = "handoff-" + str(index)
        self.store = AdmissionStore(self.database, **self.runtime["generation"], create=False)
        self.register()
        self.authority = self.operator()

    def query(self):
        before = self.database.read_bytes()
        try:
            return _fmcad_query_runtime_root(self.authority, dict(requestId="root-one"))
        finally:
            self.assertEqual(before, self.database.read_bytes(), "QUERY changed SQLite bytes")

    def unchanged_original(self, result):
        self.assertEqual({k: v for k, v in result.items() if k != "successor"}, self.original)
        self.assertEqual(self.store._db.execute("SELECT * FROM provision_fences").fetchone(),
                         self.original_row)
        self.assertEqual(result["receiptMac"], self.original["receiptMac"])

    def test_direct_is_original_query_with_null_successor(self):
        result = self.query()
        self.assertIsNone(result["successor"])
        self.assertEqual(query_fence(self.authority, dict(requestId="root-one")), self.original)
        self.unchanged_original(result)

    def test_absent_is_native_absent_with_null_successor(self):
        for table in ("provision_fence_audit", "provision_fence_head", "provision_fences"):
            self.store._db.execute("DROP TABLE " + table)
        self.assertEqual(self.query(), dict(
            kind="fmcad-provision-fence", version=1, state="absent",
            requestId="root-one", successor=None))

    def test_pending_direct_query_remains_readonly_native_pending(self):
        self.store._db.execute(
            "UPDATE provision_fences SET state='pending',publication_json=NULL,receipt_json=NULL")
        result = self.query()
        self.assertEqual(result["state"], "pending")
        self.assertIsNone(result["successor"])
        self.assertEqual({k: v for k, v in result.items() if k != "successor"},
                         query_fence(self.authority, dict(requestId="root-one")))

    def test_one_real_ordinary_handoff_and_immutable_original(self):
        self.handoff(1)
        result = self.query()
        self.unchanged_original(result)
        proof = result["successor"]
        self.assertEqual(proof["kind"], "fmcad-runtime-root-successor-v1")
        self.assertEqual(proof["currentRuntime"], self.runtime)
        self.assertEqual([x["handoffId"] for x in proof["handoffs"]], ["handoff-1"])
        self.assertEqual(proof["retirement"], dict(
            handoffId="handoff-1", nextGeneration=dict(instance="g1", epoch="e1")))
        self.assertEqual(proof["database"]["inode"], str(self.database.stat().st_ino))
        self.assertEqual(proof["database"]["device"], str(self.database.stat().st_dev))

    def test_three_real_handoffs_keep_full_chain_and_original(self):
        for index in (1, 2, 3):
            self.handoff(index)
        result = self.query()
        self.unchanged_original(result)
        self.assertEqual([x["handoffId"] for x in result["successor"]["handoffs"]],
                         ["handoff-1", "handoff-2", "handoff-3"])

    def test_query_has_exactly_one_real_read_snapshot_no_nested_transaction(self):
        self.handoff(1)
        original_transaction = AdmissionStore._transaction
        snapshots = []

        @contextmanager
        def observed_transaction(store, *, read_snapshot=False):
            snapshots.append(read_snapshot)
            with original_transaction(store, read_snapshot=read_snapshot):
                yield

        with patch.object(AdmissionStore, "_transaction", observed_transaction):
            self.unchanged_original(self.query())
        self.assertEqual(snapshots, [True])
        self.assertNotIn("adsk", sys.modules)

    def test_real_immutable_owner_guard_still_refuses_same_generation_rebinding(self):
        descriptor = dict(kind="fmcad-physical-grant", version=1, **copy.deepcopy(self.runtime),
                          brokerOwner=dict(pid=os.getpid(), birth="fixture", nonce="first-owner",
                                           clientId="offline", queueDirectory=self.posix))
        approval = native.activation_for(self.original["receiptJson"])
        self.store.bind_physical_owner(descriptor, activation=approval)
        other = copy.deepcopy(descriptor)
        other["brokerOwner"]["nonce"] = "second-owner"
        with self.assertRaisesRegex(AdmissionError, "already belongs to another owner"):
            self.store.bind_physical_owner(other, activation=approval)
        self.unchanged_original(self.query())

    def test_missing_retirement_refused(self):
        self.handoff(1)
        self.store._db.execute("DELETE FROM provision_fence_retirements")
        with self.assertRaises(AdmissionError):
            self.query()

    def test_wrong_retirement_target_refused(self):
        self.handoff(1)
        self.store._db.execute("UPDATE provision_fence_retirements SET next_epoch='wrong'")
        with self.assertRaises(AdmissionError):
            self.query()

    def test_wrong_provision_head_refused(self):
        self.handoff(1)
        self.store._db.execute("UPDATE provision_fence_head SET request_id='missing'")
        with self.assertRaises(AdmissionError):
            self.query()

    def test_missing_intermediate_handoff_refused(self):
        for index in (1, 2, 3):
            self.handoff(index)
        self.store._db.execute("DELETE FROM physical_handoffs WHERE id='handoff-2'")
        with self.assertRaises(AdmissionError):
            self.query()

    def inject(self, identifier, source, target):
        for g in (source, target):
            self.store._db.execute("INSERT OR IGNORE INTO generation_history VALUES (?,?)",
                                   (g["instance"], g["epoch"]))
        value = dict(handoffId=identifier, generation=source, nextGeneration=target, state="committed")
        self.store._db.execute("INSERT INTO physical_handoffs VALUES (?,?)", (identifier, _encode(value)))

    def test_branch_refused(self):
        self.handoff(1)
        self.inject("branch", dict(instance="g0", epoch="e0"), dict(instance="x", epoch="x"))
        with self.assertRaises(AdmissionError):
            self.query()

    def test_disconnected_cycle_refused(self):
        self.handoff(1)
        x, y = dict(instance="x", epoch="x"), dict(instance="y", epoch="y")
        self.inject("cycle-x", x, y)
        self.inject("cycle-y", y, x)
        with self.assertRaises(AdmissionError):
            self.query()

    def test_reused_handoff_identifier_in_different_row_refused(self):
        self.handoff(1)
        raw = self.store._db.execute("SELECT result FROM physical_handoffs WHERE id='handoff-1'").fetchone()[0]
        self.store._db.execute("INSERT INTO physical_handoffs VALUES ('alias',?)", (raw,))
        with self.assertRaises(AdmissionError):
            self.query()

    def test_stale_current_process_guard_refused(self):
        self.handoff(1)
        self.authority.runtime["physicalRuntime"]["birth"] = "stale-birth"
        with self.assertRaises(AdmissionError):
            self.query()

    def test_stale_current_generation_guard_refused(self):
        self.handoff(1)
        self.authority.runtime["generation"] = dict(instance="g0", epoch="e0")
        with self.assertRaises(AdmissionError):
            self.query()

    def test_current_authority_handoff_must_be_last_committed_handoff(self):
        self.handoff(1)
        self.authority.runtime["handoffId"] = "initial"
        with self.assertRaises(AdmissionError):
            self.query()

    def test_wrong_current_runtime_binding_refused(self):
        self.handoff(1)
        self.store._db.execute("UPDATE physical_runtime_binding SET binding='{}'")
        with self.assertRaises(AdmissionError):
            self.query()

    def test_wrong_verifier_key_refused(self):
        self.handoff(1)
        self.authority.key_digest = "0" * 64
        with self.assertRaises(AdmissionError):
            self.query()

    def test_corrupt_original_receipt_refused_not_remaced(self):
        self.handoff(1)
        original = json.loads(self.original["receiptJson"])
        original["fence"]["oldHead"] = "0" * 64
        self.store._db.execute("UPDATE provision_fences SET receipt_json=?", (_encode(original),))
        with self.assertRaises(AdmissionError):
            self.query()

    def test_noncanonical_original_receipt_refused_before_signer(self):
        self.handoff(1)
        self.store._db.execute(
            "UPDATE provision_fences SET receipt_json=' ' || receipt_json")
        with patch.object(native, "_response", wraps=native._response) as signer:
            with self.assertRaises(AdmissionError):
                self.query()
            signer.assert_not_called()

    def test_changed_consumer_without_original_consume_audit_refused_before_signer(self):
        self.handoff(1)
        receipt = json.loads(self.original["receiptJson"])
        receipt["consumedBy"] = "tampered-consumer"
        self.store._db.execute(
            "UPDATE provision_fences SET receipt_json=?", (_encode(receipt),))
        with patch.object(native, "_response", wraps=native._response) as signer:
            with self.assertRaises(AdmissionError):
                self.query()
            signer.assert_not_called()

    def test_original_consumer_need_not_be_current_query_operator(self):
        self.handoff(1)
        self.authority.operator_id = "different-current-query-operator"
        self.unchanged_original(self.query())

    def test_consume_resume_audit_cannot_replace_original_consume(self):
        self.handoff(1)
        self.store._db.execute(
            "UPDATE provision_fence_audit SET action='consume-resume' WHERE action='consume'")
        with patch.object(native, "_response", wraps=native._response) as signer:
            with self.assertRaises(AdmissionError):
                self.query()
            signer.assert_not_called()

    def test_noncanonical_direct_receipt_also_refused_before_signer(self):
        self.store._db.execute(
            "UPDATE provision_fences SET receipt_json=receipt_json || ' '")
        with patch.object(native, "_response", wraps=native._response) as signer:
            with self.assertRaises(AdmissionError):
                self.query()
            signer.assert_not_called()

    def test_named_database_swap_during_query_refused(self):
        self.handoff(1)
        replacement = self.root / "replacement.sqlite"
        shutil.copyfile(self.database, replacement)
        original_response = native._response

        def replace(row, authority):
            result = original_response(row, authority)
            os.replace(replacement, self.database)
            return result

        with patch.object(native, "_response", replace):
            with self.assertRaises((AdmissionError, PermissionError)):
                self.query()


unittest.main(verbosity=2)
