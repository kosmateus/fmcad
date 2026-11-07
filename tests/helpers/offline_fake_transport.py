"""Real pipe seams for mocked lifecycle clocks/process identities."""
import os
import subprocess


def attach_pipes(test, child, kwargs, stdout=b'', stderr=b''):
    for name, data in (('stdin', b''), ('stdout', stdout), ('stderr', stderr)):
        test.assertEqual(kwargs[name], subprocess.PIPE)
        reader, writer = os.pipe()
        if name == 'stdin':
            stream = os.fdopen(writer, 'wb', buffering=0)
            test.addCleanup(os.close, reader)
        else:
            os.write(writer, data)
            os.close(writer)
            stream = os.fdopen(reader, 'rb', buffering=0)
        setattr(child, name, stream)
        test.addCleanup(stream.close)
    return child
