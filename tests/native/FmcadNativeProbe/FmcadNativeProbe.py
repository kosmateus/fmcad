"""Run through Fusion's native Scripts manager, not as an MCP inline script."""
import datetime
import json
from pathlib import Path
import sys
import uuid

import adsk.core


def stream_state(stream):
    seen = set()
    while type(stream).__name__ == '_NsSanitizedWriter' and id(stream) not in seen and len(seen) < 1000:
        seen.add(id(stream))
        stream = object.__getattribute__(stream, '__dict__')['_original']
    return {'depth': len(seen), 'cycle': id(stream) in seen, 'terminal': type(stream).__name__}


def run(context):
    app = adsk.core.Application.get()
    record = {
        'id': str(uuid.uuid4()),
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'entryFile': __file__,
        'stdoutBefore': stream_state(sys.stdout),
        'stderrBefore': stream_state(sys.stderr),
        'documentsBefore': [{'creationId': d.creationId, 'isModified': d.isModified} for d in app.documents],
        'streamsModifiedByProbe': False,
        'modelModifiedByProbe': False,
    }
    # Keep native stdout and all installed filtering. Returning from print does
    # not prove external visibility; that is checked separately by the launcher.
    try:
        print('FMCAD_NATIVE_PROBE ' + record['id'])
        record['printCallReturned'] = True
    except Exception as error:
        record['printError'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        record['stdoutAfter'] = stream_state(sys.stdout)
        record['stderrAfter'] = stream_state(sys.stderr)
        record['documentsAfter'] = [{'creationId': d.creationId, 'isModified': d.isModified} for d in app.documents]
        record['documentStateUnchanged'] = record['documentsBefore'] == record['documentsAfter']
        folder = Path(__file__).parent / 'reports'
        folder.mkdir(exist_ok=True)
        with (folder / (record['id'] + '.json')).open('x', encoding='utf-8') as output:
            json.dump(record, output, ensure_ascii=True, indent=2)
            output.write('\n')
