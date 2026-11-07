"""One explicitly authorized new current-facts observation, never target replay."""
import os as _ac_os
import time as _ac_time


def capture_current_audit_facts(app: AaApplication, args: AaObject) -> AaObject:
    proof_path, binding_hash, original_rpc = (args.get(k) for k in ('proofPath', 'bindingHash', 'originalRpcId'))
    if not isinstance(proof_path, str) or not isinstance(binding_hash, str) or not isinstance(original_rpc, str):
        raise ValueError('Exact broker-derived original audit and capture proof binding required')
    # Exclusive started evidence also protects against accidental remote replay.
    with open(proof_path + '.started', 'x', encoding='utf-8') as file:
        _aa_json.dump({'bindingHash': binding_hash, 'originalRpcId': original_rpc}, file, allow_nan=False)
        file.flush()
        _ac_os.fsync(file.fileno())
    summary = atomic_recovery_audit(app, args)
    value: AaObject = {'version': 1, 'kind': 'atomic-current-facts-capture-v1', 'bindingHash': binding_hash,
        'originalRpcId': original_rpc, 'observedAtMs': int(_ac_time.time() * 1000), 'summary': summary,
        'historicalOutcome': 'unknown', 'modelValidation': 'not_performed', 'rollbackVerification': 'not_performed'}
    with open(proof_path, 'x', encoding='utf-8') as file:
        _aa_json.dump(value, file, allow_nan=False)
        file.flush()
        _ac_os.fsync(file.fileno())
    return value
