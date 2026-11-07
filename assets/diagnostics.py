"""Redact diagnostic copies only; CAD payloads and execution stdout stay intact."""
import codecs
import re


_CREDENTIAL_NAMES = r'authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|mcp-session-id|access_token|refresh_token|client_secret|password|api_key|secret'
_CREDENTIAL_PREFIX = r'''(["']?(?:''' + _CREDENTIAL_NAMES + r''')["']?\s*[:=]\s*)'''
_RAW_HEADER_PREFIX = r'([ \t]*(?:' + _CREDENTIAL_NAMES + r')[ \t]*[:=][ \t]*)'


def redact_diagnostic(value):
    # Structured diagnostic copies must be redacted before JSON serialization:
    # matching escaped nested JSON as raw text can corrupt the outer document.
    if isinstance(value, dict):
        return {key: '[REDACTED]' if re.fullmatch(_CREDENTIAL_NAMES, str(key), re.I)
                else redact_diagnostic(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_diagnostic(item) for item in value]
    if not isinstance(value, str):
        return value
    def url(match):
        text = re.sub(r'(https?://)[^/]*@', r'\1[REDACTED]@', match[0], flags=re.I)
        return re.sub(r'([?&#](?:access_token|refresh_token|token|api[_-]?key|key|secret|password|signature|sig|credential)=)[^&#]*',
                      r'\1[REDACTED]', text, flags=re.I)
    # Unquoted line-start headers are not JSON: commas belong to the secret.
    text = re.sub(r'^' + _RAW_HEADER_PREFIX + r'(?:\r?\n)?[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*',
                  lambda match: match[1] + '[REDACTED]', str(value), flags=re.I | re.M)
    text = re.sub(r'''https?://[^\s"'<>]+''', url, text, flags=re.I)
    def header(match):
        quote = '"' if re.match(r'^"[^"\r\n]+"\s*:', match[1]) else match[2][0] if match[2][0] in ('"', "'") else ''
        return match[1] + quote + '[REDACTED]' + quote
    text = re.sub(_CREDENTIAL_PREFIX + r'''("(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\r\n,"'}]+)''',
                  header, text, flags=re.I)
    return re.sub(r'\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+', r'\1 [REDACTED]', text, flags=re.I)


class DiagnosticStream:
    """Keep incomplete UTF-8/lines in memory; emit only sanitized complete lines.

    Folded credential headers (and a credential value on the following line)
    remain redacted across feeds. No size cap or raw spill to disk.
    """
    def __init__(self, write):
        self.write = write
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.pending = ''
        self.credential = False
        self.value_pending = False
        self.json_pending = ''

    def feed(self, chunk, final=False):
        lines = (self.pending + self.decoder.decode(chunk, final=final)).split('\n')
        self.pending = lines.pop()
        if final and self.pending:
            lines.append(self.pending)
            self.pending = ''
        sanitized = []
        for index, line in enumerate(lines):
            ending = '' if final and index == len(lines)-1 and not chunk.endswith(b'\n') else '\n'
            if self.json_pending:
                line = self.json_pending + line
                self.json_pending = ''
            # Hold only a quoted credential key lacking its value. Redact the
            # combined key/value so quotes, commas and scalar JSON stay valid.
            if re.search(r'''["'](?:''' + _CREDENTIAL_NAMES + r''')["']\s*:\s*$''', line, re.I):
                self.json_pending = line + ending
                continue
            continuation = self.value_pending or (self.credential and line.startswith((' ', '\t')))
            prefix = re.match(_RAW_HEADER_PREFIX, line, re.I)
            self.value_pending = bool(prefix and not line[prefix.end():].strip())
            self.credential = bool(prefix) or (continuation and bool(line.strip()))
            text = '[REDACTED]' if continuation and line.strip() else redact_diagnostic(line)
            sanitized.append(text + ending)
        if final and self.json_pending:
            sanitized.append(redact_diagnostic(self.json_pending))
            self.json_pending = ''
        if sanitized:
            self.write(''.join(sanitized))
