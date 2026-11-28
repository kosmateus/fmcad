import { receiptIdentitySource } from "./receipt-identity.js";

export interface CameraReceiptBinding {
  readonly jobId: string;
  readonly rpcId: string;
  readonly requestHash: string;
  readonly buildHash: string;
  readonly sourceHash: string;
}

/** Pure canonical source; offline checking and wire erasure use the same generator. */
export function cameraReceiptSource(
  code: string,
  mappedPath: string,
  binding: CameraReceiptBinding,
): string {
  const keys = ["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"];
  if (
    !code.trim() ||
    !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(mappedPath) ||
    !binding ||
    Object.keys(binding).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(binding, key) ||
        typeof binding[key as keyof CameraReceiptBinding] !== "string" ||
        !binding[key as keyof CameraReceiptBinding],
    )
  )
    throw new Error("Invalid ordinary Windows camera receipt binding");
  const literal = JSON.stringify(
    Object.fromEntries(
      keys.map((key) => [key, binding[key as keyof CameraReceiptBinding]]),
    ),
  ).slice(0, -1);
  return `${receiptIdentitySource("windows")}
import json as _qr_json, uuid as _qr_uuid, traceback as _qr_traceback
_qr_path = ${JSON.stringify(mappedPath)}
_qr_outcome = 'failed'
_qr_error: dict[str, str] | None = None
try:
    exec(compile(${JSON.stringify(code)}, '<fmcad-queue>', 'exec'), {})
    _qr_outcome = 'succeeded'
except BaseException as _qr_exception:
    _qr_error = {'type':type(_qr_exception).__name__, 'message':str(_qr_exception),
                 'traceback':_qr_traceback.format_exc()[-16384:]}
    raise
finally:
    _qr_record: dict[str, object] = ${literal},'terminal':True,'outcome':_qr_outcome,'instance':_qi_identity()}
    if _qr_error is not None: _qr_record['error'] = _qr_error
    _qr_temp = _qr_path + '.' + str(_qr_uuid.uuid4()) + '.tmp'
    with open(_qr_temp, 'x', encoding='utf-8') as _qr_file:
        _qr_json.dump(_qr_record, _qr_file, allow_nan=False)
        _qr_file.flush()
        _qi_os.fsync(_qr_file.fileno())
    _qi_os.replace(_qr_temp, _qr_path)
`;
}
