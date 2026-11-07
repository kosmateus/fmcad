"""Execute generated run scripts against offline document doubles, never Fusion."""
import contextlib
import io
import json
import sys
import types


def execute(request):
    events = []
    app = types.SimpleNamespace()

    class Document:
        def __init__(self, name, creation, cloud):
            self.name, self.creationId = name, creation
            self.dataFile = types.SimpleNamespace(id=cloud) if cloud else None

        def activate(self):
            events.append('activate')
            if scenario != 'no-switch':
                app.activeDocument = self
            if scenario == 'activation-transition':
                self.creationId = 'after-save'
            return scenario != 'false-activation'

    scenario = request.get('scenario', '')
    target = Document('Módèl', 'creation-original', 'urn:cloud:original')
    other = Document('Other', 'other', 'other-file')
    documents = [target, other]
    app.activeDocument = target if scenario == 'already-active' else other
    if scenario == 'duplicate':
        other.name = target.name
    if scenario == 'missing':
        documents.remove(target)
    if scenario == 'unsaved':
        target.dataFile = None
    if scenario == 'stale-cloud':
        target.dataFile.id = 'replacement-file'
    # Exercise the SDK collection form rather than just Python lists.
    app.documents = types.SimpleNamespace(count=len(documents), item=documents.__getitem__)
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.core.Application = types.SimpleNamespace(get=lambda: app)
    probe = types.ModuleType('run_probe')
    probe.events, probe.app = events, app
    sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'run_probe': probe})
    namespace = {}
    output = io.StringIO()
    error = None
    with contextlib.redirect_stdout(output):
        try:
            exec(compile(request['script'], '<backend>', 'exec'), namespace)
            loaded_events = list(events)
            if scenario == 'late-replacement':
                target.creationId = 'after-save'
            namespace['run']('context-✓')
        except Exception as exc:
            error = type(exc).__name__ + ': ' + str(exc)
    return {'error': error, 'events': events, 'loadedEvents': locals().get('loaded_events'),
            'active': app.activeDocument.name, 'text': output.getvalue()}


if __name__ == '__main__':
    print(json.dumps([execute(request) for request in json.load(sys.stdin)]))
