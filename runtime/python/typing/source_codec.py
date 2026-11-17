"""Lossless native source envelope; only stdlib literal/AST decoding offline."""
import ast
import base64
import hashlib
import inspect
import json
import zlib


HEADER = '# FMCAD native source envelope v1\n'
FILENAME = '<fmcad-native-source>'
MAX_SOURCE_BYTES = 16 * 1024 * 1024


def _json_string_bytes(value):
    return len(json.dumps(value, ensure_ascii=False).encode('utf-8'))


def decode_payload(payload: str, size: int, digest: str) -> str:
    import base64 as _base64
    import hashlib as _hashlib
    import zlib as _zlib
    if type(size) is not int or not 0 <= size <= 16 * 1024 * 1024:
        raise ValueError('Native source size exceeds 16 MiB')
    if type(payload) is not str or len(payload) > 24 * 1024 * 1024:
        raise ValueError('Native source encoding exceeds 24 MiB')
    if type(digest) is not str or len(digest) != 64:
        raise ValueError('Invalid native source digest')
    packed = _base64.b64decode(payload, validate=True)
    if _base64.b64encode(packed).decode('ascii') != payload:
        raise ValueError('Noncanonical native source encoding')
    decoder = _zlib.decompressobj()
    decoded = decoder.decompress(packed, size + 1)
    if (len(decoded) != size or not decoder.eof or decoder.unconsumed_tail
            or decoder.unused_data):
        raise ValueError('Native source size or stream boundary mismatch')
    if _hashlib.sha256(decoded).hexdigest() != digest:
        raise ValueError('Native source digest mismatch')
    source = decoded.decode('utf-8', errors='strict')
    # No codec name leaks into the decoded module's global namespace. Offline
    # callers invoke decode_payload; this private name exists only on the wire.
    globals().pop('_fmcad_decode_source_v1', None)
    return source


def envelope(payload, size, digest):
    # One implementation: the runtime function is copied from this trusted file,
    # never compiled or evaluated to inventory submitted source.
    decoder = inspect.getsource(decode_payload).replace(
        'def decode_payload(', 'def _fmcad_decode_source_v1(', 1)
    return (HEADER + decoder + '\nexec(compile(_fmcad_decode_source_v1('
            + repr(payload) + ', ' + repr(size) + ', ' + repr(digest)
            + '), ' + repr(FILENAME) + ", 'exec'), globals())\n")


def encode_source(source):
    data = source.encode('utf-8')
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError('Native source size exceeds 16 MiB')
    encoded = envelope(base64.b64encode(zlib.compress(data, 9)).decode('ascii'),
                       len(data), hashlib.sha256(data).hexdigest())
    return encoded if _json_string_bytes(encoded) < _json_string_bytes(source) else source


def decoded_envelope(source, tree):
    """Recognize the entire known AST, not arbitrary calls to a decoder name."""
    if not source.startswith(HEADER):
        return None
    if not any(isinstance(node, ast.FunctionDef)
               and node.name == '_fmcad_decode_source_v1' for node in tree.body):
        return None
    body = tree.body
    addin_entrypoint = False
    if body and isinstance(body[-1], ast.Expr) and isinstance(body[-1].value, ast.Call):
        suffix = body[-1].value
        addin_entrypoint = (isinstance(suffix.func, ast.Name)
                            and suffix.func.id == 'run' and len(suffix.args) == 1
                            and not suffix.keywords
                            and isinstance(suffix.args[0], ast.Constant)
                            and suffix.args[0].value == '')
        if addin_entrypoint:
            body = body[:-1]
    try:
        call = body[-1].value.args[0].args[0]
        if not isinstance(call, ast.Call) or len(call.args) != 3:
            raise ValueError('Invalid native source envelope')
        payload, size, digest = [ast.literal_eval(arg) for arg in call.args]
        expected_source = envelope(payload, size, digest)
        if addin_entrypoint:
            expected_source += '\nrun("")\n'
        expected = ast.parse(expected_source)
        if ast.dump(tree) != ast.dump(expected):
            raise ValueError('Native source decoder AST mismatch')
    except (AttributeError, IndexError, TypeError, SyntaxError) as error:
        raise ValueError('Invalid native source envelope') from error
    decoded = decode_payload(payload, size, digest)
    if addin_entrypoint:
        tree.body.pop()
    return decoded
